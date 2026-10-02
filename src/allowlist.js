/**
 * The runtime allowlist: grants a human adds with `/bus allow`, which survive a
 * restart.
 *
 * The config `allow` list stays the baseline. Runtime grants are **additive and
 * revocable**: `/bus allow` can only widen access for one directed pair, and
 * `/bus revoke` can only take back a grant made this way. It cannot subtract from
 * the config, so a pair the config permits stays permitted and `/bus list` says
 * which source permits it rather than pretending the revoke worked.
 *
 * @module dsh-peer-bus/allowlist
 */
/**
 * The storage-domain declaration for one schema.
 *
 * A plain object rather than `defineDomain(...)`: that helper only brands and
 * validates a spec, and importing it would turn `@deepseek-ai/dsh-storage-domain`
 * into a hard dependency of a capability this plugin treats as optional. The name
 * must satisfy the storage layer's `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`), which
 * is why it uses underscores rather than the package's usual hyphens.
 *
 * @param schema - durable-state schema; must be a zod schema.
 * @returns the spec to hand to `ctx.storageDomain.open()`.
 */
const allowlistDomain = (schema) => ({
  name: 'peer_bus_allowlist',
  version: 1,
  tables: {},
  global: { schema, initial: { grants: [] } },
});

/**
 * Build the durable-state schema, or report that this install cannot.
 *
 * The storage domain layer validates stored records with **zod**
 * (`schema.parse` / `schema.safeParse`), not with this package's own
 * `schemastery` — `dsh-workspace` declares its domain the same way. The two
 * schema libraries therefore live side by side here, each where its framework
 * requires it.
 *
 * `zod` is imported lazily and treated as optional. It is not a dependency of
 * this package, only of the DSH packages that own the storage layer, so it may not
 * be resolvable from a given install; when it is not, the runtime allowlist stays
 * in memory rather than taking the whole plugin down with it.
 *
 * @returns the schema, or undefined when zod cannot be resolved.
 */
async function loadStateSchema() {
  try {
    const { z } = await import('zod');
    return z.object({
      grants: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
    });
  } catch {
    return undefined;
  }
}

/** Key for one directed grant. A NUL cannot appear in a session id. */
const pairKey = (from, to) => `${from}\u0000${to}`;

/**
 * Grants held in memory, written through to storage when one is available.
 *
 * Reading is synchronous from the in-memory set so the permission check stays a
 * pure function; {@link ready} resolves once the durable state has been adopted,
 * and every caller that makes a decision awaits it first.
 */
class RuntimeAllowlist {
  /**
   * @param ctx - the plugin's own context. This class is not a Cordis service, so
   *   `this.ctx` is never shadowed and stays readable after an await; only a
   *   service method has to resolve its dependencies up front.
   */
  constructor(ctx) {
    this.ctx = ctx;
    /** Granted `from\0to` pairs. */
    this.keys = new Set();
    /** The same grants in grant order, for `/bus list`. */
    this.entries = [];
    /** The in-flight or settled load; started by the first read of {@link ready}. */
    this.loading = undefined;
  }

  /**
   * Resolves once durable state has been read, or found unavailable.
   *
   * The load is started on first access rather than in the constructor, because
   * `storageDomain` mounts from an injected fiber: at plugin-apply time it does
   * not exist yet, so a constructor-time read would silently find nothing and
   * leave the allowlist memory-only for the life of the process. Every path that
   * makes a permission decision reaches this through `roster()`, which by then is
   * past composition.
   *
   * @returns the load promise, which never rejects.
   */
  get ready() {
    this.loading ??= this.open();
    return this.loading;
  }

  /**
   * Open the durable domain once, if this composition has one.
   *
   * Never rejects: a profile with no storage domain keeps runtime grants in
   * memory for the life of the process, which is strictly better than refusing to
   * start. A domain that cannot be opened is reported, because silently dropping
   * persistence would look like a bug in `/bus allow` later.
   *
   * @returns fulfillment once the durable grants have been adopted.
   */
  async open() {
    const facility = this.ctx.get('storageDomain');
    if (facility === undefined) return;
    const schema = await loadStateSchema();
    if (schema === undefined) {
      this.ctx.logger?.warn?.(
        'peer-bus runtime allowlist is memory-only: the storage domain layer validates with zod, and zod is not resolvable from this install',
      );
      return;
    }
    try {
      this.domain = await facility.open(allowlistDomain(schema));
      this.adopt(this.domain.global.get().grants);
    } catch (error) {
      this.ctx.logger?.warn?.(
        `peer-bus runtime allowlist is memory-only: ${error?.message ?? String(error)}`,
      );
    }
  }

  /**
   * Replace the in-memory set from a durable snapshot, dropping duplicates.
   *
   * @param grants - stored `{from, to}` records.
   */
  adopt(grants) {
    this.keys = new Set();
    this.entries = [];
    for (const grant of grants) {
      const key = pairKey(grant.from, grant.to);
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      this.entries.push({ from: grant.from, to: grant.to });
    }
  }

  /**
   * Whether one directed pair was granted at runtime.
   *
   * @param from - sender session id.
   * @param to - target session id.
   * @returns true when `/bus allow` created this exact direction.
   */
  has(from, to) {
    return this.keys.has(pairKey(from, to));
  }

  /**
   * Grant one direction and persist it.
   *
   * Waits for the initial load first: adopting a durable snapshot replaces the
   * in-memory set, so a grant made while the domain was still opening would be
   * wiped by the snapshot it raced — and, before the domain existed, would never
   * have been written through either.
   *
   * @param from - sender session id the grant admits.
   * @param to - target session id it admits them to.
   * @returns true when this call created the grant, false when it already existed.
   */
  async grant(from, to) {
    await this.ready;
    if (this.has(from, to)) return false;
    this.keys.add(pairKey(from, to));
    this.entries.push({ from, to });
    await this.persist();
    return true;
  }

  /**
   * Take back one runtime grant and persist the removal.
   *
   * @param from - sender session id to disallow.
   * @param to - target session id.
   * @returns true when a grant was removed, false when there was none.
   */
  async revoke(from, to) {
    await this.ready;
    if (!this.has(from, to)) return false;
    this.keys.delete(pairKey(from, to));
    this.entries = this.entries.filter((entry) => entry.from !== from || entry.to !== to);
    await this.persist();
    return true;
  }

  /**
   * Write the current grants through to storage.
   *
   * @throws whatever the backend rejects with; the caller reports it rather than
   *   pretending the grant is durable.
   */
  async persist() {
    if (this.domain === undefined) return;
    await this.domain.global.set({
      grants: this.entries.map(({ from, to }) => ({ from, to })),
    });
  }

  /**
   * Release the domain handle.
   *
   * @returns fulfillment once the domain is closed.
   */
  async close() {
    const domain = this.domain;
    this.domain = undefined;
    await domain?.close?.();
  }
}

export { RuntimeAllowlist, allowlistDomain, loadStateSchema, pairKey };
