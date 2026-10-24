/**
 * Safety guards applied to every browser context.
 *
 * - Host allowlist: optional (ARGUS_ALLOWED_HOSTS). Restricts which sites
 *   the agent may load as the top-level page.
 * - Payment guard: always on. Blocks requests that would reach a payment
 *   provider's LIVE environment, so an agent can never charge a real card.
 *   Sandbox/test environments (Stripe pk_test_, Braintree sandbox, Adyen test,
 *   PayPal sandbox) are untouched.
 *
 * Pure functions only; BrowserManager wires them into Playwright routes.
 */

/** Stripe live publishable/secret/restricted keys. */
const LIVE_KEY_PATTERN = /\b(?:pk|sk|rk)_live_[A-Za-z0-9]{8,}/;

/** True if the text contains a live payment API key. */
export function containsLivePaymentKey(text: string): boolean {
  return LIVE_KEY_PATTERN.test(text);
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Hosts whose requests the payment guard needs to inspect. */
export function isPaymentProviderHost(host: string): boolean {
  return (
    hostMatches(host, "stripe.com") ||
    hostMatches(host, "stripe.network") ||
    hostMatches(host, "adyen.com") ||
    hostMatches(host, "adyenpayments.com") ||
    hostMatches(host, "braintreegateway.com") ||
    hostMatches(host, "braintree-api.com") ||
    hostMatches(host, "paypal.com")
  );
}

/**
 * Returns a reason string if this request targets a live payment
 * environment, or null if it is safe (sandbox/test or unrelated).
 */
export function livePaymentBlockReason(url: URL, postData: string | null): string | null {
  const host = url.hostname.toLowerCase();

  if (hostMatches(host, "stripe.com") || hostMatches(host, "stripe.network")) {
    if (containsLivePaymentKey(url.href) || (postData !== null && containsLivePaymentKey(postData))) {
      return "Stripe request uses a live API key (pk_live_/sk_live_/rk_live_)";
    }
    return null;
  }
  // Adyen live endpoints carry "live" in the host (checkout-live, *-live.adyenpayments.com, live.adyen.com).
  if ((hostMatches(host, "adyen.com") || hostMatches(host, "adyenpayments.com")) && /(^|[.-])live[.-]/.test(host)) {
    return "Adyen live environment";
  }
  // Braintree production API hosts; sandbox hosts contain ".sandbox.".
  if (
    (hostMatches(host, "braintreegateway.com") || hostMatches(host, "braintree-api.com")) &&
    !host.includes("sandbox")
  ) {
    return "Braintree production environment";
  }
  // PayPal live REST APIs; sandbox is api(-m).sandbox.paypal.com.
  if (host === "api.paypal.com" || host === "api-m.paypal.com") {
    return "PayPal live API";
  }
  return null;
}

/**
 * Optional list of hosts the top-level page may load. An entry matches the
 * host itself and all of its subdomains ("example.com" allows
 * "www.example.com"). Non-network schemes (file:, about:, data:) are always
 * allowed so local test pages keep working.
 */
export class HostAllowlist {
  private readonly domains: string[];

  constructor(raw: string | undefined) {
    this.domains = (raw ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase().replace(/^\*\./, ""))
      .filter((entry) => entry !== "");
  }

  get enabled(): boolean {
    return this.domains.length > 0;
  }

  get entries(): readonly string[] {
    return this.domains;
  }

  allows(rawUrl: string): boolean {
    if (!this.enabled) return true;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return true;
    const host = url.hostname.toLowerCase();
    return this.domains.some((domain) => hostMatches(host, domain));
  }
}

/** Rough "same site" check: compares the last two host labels. */
export function sameSite(a: string, b: string): boolean {
  const site = (host: string): string => host.toLowerCase().split(".").slice(-2).join(".");
  return site(a) === site(b);
}
