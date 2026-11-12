import type { Server } from "bun";
import type { BaseApp } from "astro/app";

type AllowedDomains = NonNullable<ReturnType<BaseApp["getAllowedDomains"]>>;

/**
 * The request Astro renders, and the client's address for `app.render()`. Bun builds `request.url` from the Host header, which the client writes, so the URL is kept only when Host matches `security.allowedDomains`; otherwise it is `localhost` on the server's port, as in Astro's Node adapter. Astro applies X-Forwarded-Proto, -Host, and -Port itself.
 * The client's address is the first X-Forwarded-For entry when Host or X-Forwarded-Host matched, else the socket's.
 * The rules are Astro's since 7.4.11 (`validateHost` and `validateForwardedHeaders`, which it does not export; `BaseApp.validateForwardedHost` keeps the older ones): X-Forwarded-Proto counts only when an entry allows it for the host in use, and an entry matches protocol, host, and port together.
 */
export function forAstro(
  request: Request,
  server: Server<unknown>,
  domains: AllowedDomains,
): { request: Request; clientAddress: string | undefined } {
  const { headers } = request;
  const scheme = request.url.startsWith("https:") ? "https" : "http";
  let hostTrusted = false;
  let proxied = false;
  if (domains.length > 0) {
    let proto = first(headers.get("x-forwarded-proto"));
    if (proto !== undefined && !/^[a-z][a-z0-9+.-]*$/i.test(proto))
      proto = undefined;
    let port = first(headers.get("x-forwarded-port"));
    if (port !== undefined && !/^\d{1,5}$/.test(port)) port = undefined;
    const protocols = proto === undefined ? [scheme] : [proto, scheme];
    const host = parseHost(headers.get("host"));
    const forwardedHost = parseHost(first(headers.get("x-forwarded-host")));
    // The protocol an entry allows for X-Forwarded-Host, else for Host: the host in use.
    const forwarded =
      forwardedHost && protocolFor(forwardedHost, protocols, port, domains);
    const protocol =
      forwarded ?? (host && protocolFor(host, protocols, port, domains));
    // The protocol Host is validated with: X-Forwarded-Proto when an entry allowed it for the host in use, else the server's.
    const hostProtocol =
      proto !== undefined && protocol === proto ? proto : scheme;
    hostTrusted = host !== undefined && admits(domains, hostProtocol, host);
    proxied = hostTrusted || forwarded !== undefined;
  }
  return {
    request: hostTrusted
      ? request
      : onLocalhost(request, `${scheme}://localhost:${server.port}`),
    clientAddress:
      (proxied ? first(headers.get("x-forwarded-for")) : undefined) ??
      server.requestIP(request)?.address,
  };
}

/** The first value of a header that proxies join with commas. */
function first(value: string | null): string | undefined {
  if (value === null) return undefined;
  const comma = value.indexOf(",");
  return (comma === -1 ? value : value.slice(0, comma)).trim() || undefined;
}

interface Host {
  hostname: string;
  port: string | undefined;
}

/**
 * A plain `hostname[:port]`, the only Host or X-Forwarded-Host Astro accepts, with the hostname a URL reads from it.
 * Anything else is refused: with `/`, `\`, or `@`, Bun's `request.url` is a bare path, not a URL.
 */
function parseHost(value: string | null | undefined): Host | undefined {
  if (!value || !/^[\w-]+(?:\.[\w-]+)*(?::\d{1,5})?$/.test(value))
    return undefined;
  const [name, port] = value.split(":") as [string, string?];
  const hostname = URL.parse(`http://${value}`)?.hostname;
  return hostname === name.toLowerCase() ? { hostname, port } : undefined;
}

/** The first protocol an entry allows for this host, with the forwarded port or without it. */
function protocolFor(
  host: Host,
  protocols: string[],
  port: string | undefined,
  domains: AllowedDomains,
): string | undefined {
  return protocols.find(
    (protocol) =>
      (port !== undefined && admits(domains, protocol, host, port)) ||
      admits(domains, protocol, host),
  );
}

const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

/**
 * Whether an entry allows this protocol, host, and port together. An entry without a protocol allows http and https.
 * A forwarded port matches only an entry that lists it; otherwise an entry's port matches the host's, or the protocol's default.
 */
function admits(
  domains: AllowedDomains,
  protocol: string,
  host: Host,
  forwardedPort?: string,
): boolean {
  return domains.some(
    (entry) =>
      (entry.protocol === undefined
        ? protocol === "http" || protocol === "https"
        : entry.protocol === protocol.toLowerCase()) &&
      hostnameMatches(host.hostname, entry.hostname) &&
      (forwardedPort !== undefined
        ? entry.port === forwardedPort
        : entry.port === undefined ||
          entry.port === (host.port ?? DEFAULT_PORTS[protocol.toLowerCase()])),
  );
}

/** An entry's hostname, where `*.` stands for one subdomain level and `**.` for any. */
function hostnameMatches(
  hostname: string,
  pattern: string | undefined,
): boolean {
  if (!pattern) return true;
  if (pattern.startsWith("**.")) {
    const base = pattern.slice(2);
    return hostname !== base && hostname.endsWith(base);
  }
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(1);
    return (
      hostname.endsWith(base) && !hostname.slice(0, -base.length).includes(".")
    );
  }
  return pattern === hostname;
}

/** The path and query of `request.url` as Bun built it: a full URL, or a bare path when Host was unusable. */
export function pathAndQuery(url: string): string {
  const at = url.startsWith("/") ? 0 : url.indexOf("/", url.indexOf("//") + 2);
  return at === -1 ? "/" : url.slice(at);
}

/** The same request at another origin. */
function onLocalhost(request: Request, origin: string): Request {
  return new Request(origin + pathAndQuery(request.url), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  });
}
