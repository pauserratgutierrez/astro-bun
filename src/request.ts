import type { Server } from "bun";
import { BaseApp } from "astro/app";

type AllowedDomains = NonNullable<ReturnType<BaseApp["getAllowedDomains"]>>;

// Where `app.render()` reads the client's address.
const CLIENT_ADDRESS = Symbol.for("astro.clientAddress");

/**
 * The request Astro renders. Bun builds `request.url` from the Host header, which the client writes, so the URL is kept only when Host matches `security.allowedDomains`; otherwise it is `localhost` on the server's port, as in Astro's Node adapter. Astro applies X-Forwarded-Proto, -Host, and -Port itself.
 * The client's address is the first X-Forwarded-For entry when Host or X-Forwarded-Host matched, else the socket's.
 */
export function forAstro(
  request: Request,
  server: Server<unknown>,
  domains: AllowedDomains,
): Request {
  const { headers } = request;
  const scheme = request.url.startsWith("https:") ? "https" : "http";
  let hostTrusted = false;
  let proxied = false;
  if (domains.length > 0) {
    const protocol = forwardedProtocol(
      first(headers.get("x-forwarded-proto")),
      domains,
    );
    hostTrusted = allowed(
      headers.get("host") ?? undefined,
      protocol ?? scheme,
      domains,
    );
    proxied =
      hostTrusted ||
      allowed(forwardedHost(headers, domains), protocol ?? "https", domains);
  }
  const astroRequest = hostTrusted
    ? request
    : onLocalhost(request, `${scheme}://localhost:${server.port}`);
  const client =
    (proxied ? first(headers.get("x-forwarded-for")) : undefined) ??
    server.requestIP(request)?.address;
  if (client !== undefined) Reflect.set(astroRequest, CLIENT_ADDRESS, client);
  return astroRequest;
}

/** The first value of a header that proxies join with commas. */
function first(value: string | null): string | undefined {
  if (value === null) return undefined;
  const comma = value.indexOf(",");
  return (comma === -1 ? value : value.slice(0, comma)).trim() || undefined;
}

/**
 * Whether Astro may build its URL from this host: a hostname and at most one port, matching an allowed domain for the protocol.
 * A host with `/`, `\`, or `@` is refused: for those Bun's `request.url` is a bare path, not a URL.
 */
function allowed(
  host: string | undefined,
  protocol: string,
  domains: AllowedDomains,
): boolean {
  return (
    host !== undefined &&
    !/[/\\@]/.test(host) &&
    host.split(":").length <= 2 &&
    BaseApp.validateForwardedHost(host, domains, protocol)
  );
}

/** X-Forwarded-Proto when the allowed domains accept it: one of their protocols, or http and https when they name none. */
function forwardedProtocol(
  value: string | undefined,
  domains: AllowedDomains,
): string | undefined {
  if (value === undefined) return undefined;
  const protocol = value.toLowerCase();
  const named = domains.filter((domain) => domain.protocol !== undefined);
  const ok =
    named.length > 0
      ? named.some((domain) => domain.protocol === protocol)
      : protocol === "http" || protocol === "https";
  return ok ? protocol : undefined;
}

/** X-Forwarded-Host, with X-Forwarded-Port when an allowed domain names that port. */
function forwardedHost(
  headers: Headers,
  domains: AllowedDomains,
): string | undefined {
  const host = first(headers.get("x-forwarded-host"));
  const port = first(headers.get("x-forwarded-port"));
  if (
    host === undefined ||
    port === undefined ||
    !domains.some((domain) => domain.port === port)
  )
    return host;
  return `${host.split(":", 1)[0]}:${port}`;
}

/** The same request at another origin. Its path is taken from `request.url` as Bun built it: a full URL, or a bare path when Host was unusable. */
function onLocalhost(request: Request, origin: string): Request {
  const { url } = request;
  const at = url.startsWith("/") ? 0 : url.indexOf("/", url.indexOf("//") + 2);
  return new Request(origin + (at === -1 ? "/" : url.slice(at)), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  });
}
