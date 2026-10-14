import { describe, expect, it } from "vitest";
import {
  checkBearerToken,
  checkSlackSigningSecret,
  decodeSigningSecret,
  generateBearerToken,
  generateSigningSecret,
  hashToken,
  signSlackRequest,
  signStandardWebhook,
  verifyBearer,
  verifySlack,
  verifyStandardWebhook,
} from "./auth.js";

// The published Standard Webhooks reference vector (also used by the svix libraries PostHog follows).
const VECTOR = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

const headersOf = (values: Record<string, string>) => new Headers(values);
const verify = (headers: Record<string, string>, body = VECTOR.body, nowSeconds = VECTOR.timestamp) =>
  verifyStandardWebhook({ key: decodeSigningSecret(VECTOR.secret), headers: headersOf(headers), body: Buffer.from(body), nowSeconds, toleranceSeconds: 300 });
const vectorHeaders = { "webhook-id": VECTOR.id, "webhook-timestamp": String(VECTOR.timestamp), "webhook-signature": VECTOR.signature };

describe("Standard Webhooks signatures", () => {
  it("matches the reference vector", () => {
    expect(signStandardWebhook(VECTOR)).toBe(VECTOR.signature);
    expect(verify(vectorHeaders)).toEqual({ ok: true, webhookId: VECTOR.id });
  });

  it("accepts any matching signature in a space-separated list", () => {
    expect(verify({ ...vectorHeaders, "webhook-signature": `v1,AAAA v2,zzzz ${VECTOR.signature}` }).ok).toBe(true);
  });

  it("rejects a changed body, id, or timestamp", () => {
    expect(verify(vectorHeaders, '{"test": 2432232315}')).toEqual({ ok: false, reason: "mismatch" });
    expect(verify({ ...vectorHeaders, "webhook-id": "msg_other" })).toEqual({ ok: false, reason: "mismatch" });
    expect(verify({ ...vectorHeaders, "webhook-timestamp": String(VECTOR.timestamp + 1) }, VECTOR.body)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects timestamps outside five minutes either way", () => {
    expect(verify(vectorHeaders, VECTOR.body, VECTOR.timestamp + 301)).toEqual({ ok: false, reason: "stale" });
    expect(verify(vectorHeaders, VECTOR.body, VECTOR.timestamp - 301)).toEqual({ ok: false, reason: "stale" });
    expect(verify(vectorHeaders, VECTOR.body, VECTOR.timestamp + 299).ok).toBe(true);
  });

  it("names missing and malformed headers", () => {
    expect(verify({})).toEqual({ ok: false, reason: "missing" });
    expect(verify({ ...vectorHeaders, "webhook-timestamp": "soon" })).toEqual({ ok: false, reason: "malformed" });
    expect(verify({ ...vectorHeaders, "webhook-signature": "v1" })).toEqual({ ok: false, reason: "malformed" });
  });

  it("generates secrets that decode to 32 bytes and rejects weak ones", () => {
    const secret = generateSigningSecret();
    expect(secret).toMatch(/^whsec_/);
    expect(decodeSigningSecret(secret)).toHaveLength(32);
    expect(() => decodeSigningSecret("whsec_c2hvcnQ=")).toThrow();
    expect(() => decodeSigningSecret("not a secret")).toThrow();
  });
});

describe("bearer tokens", () => {
  it("compares hashes and never needs the token stored", () => {
    const token = generateBearerToken();
    const tokenHash = hashToken(token);
    expect(verifyBearer({ tokenHash, headers: headersOf({ authorization: `Bearer ${token}` }) })).toEqual({ ok: true, webhookId: null });
    expect(verifyBearer({ tokenHash, headers: headersOf({ authorization: `Bearer ${token}x` }) })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyBearer({ tokenHash, headers: headersOf({ authorization: `Basic ${token}` }) })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyBearer({ tokenHash, headers: headersOf({}) })).toEqual({ ok: false, reason: "missing" });
  });

  it("requires imported tokens to be long and free of whitespace", () => {
    expect(() => checkBearerToken("short")).toThrow();
    expect(() => checkBearerToken(`${"a".repeat(20)} ${"b".repeat(20)}`)).toThrow();
    expect(checkBearerToken("t".repeat(40))).toBe("t".repeat(40));
  });
});

// The worked example from Slack's "Verifying requests from Slack" guide.
const SLACK = {
  secret: "8f742231b10e8888abcd99yyyzzz85a5",
  timestamp: 1531420618,
  body: "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c",
  signature: "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
};
const slackHeaders = { "x-slack-request-timestamp": String(SLACK.timestamp), "x-slack-signature": SLACK.signature };
const verifySlackWith = (headers: Record<string, string>, body = SLACK.body, nowSeconds = SLACK.timestamp) =>
  verifySlack({ secret: SLACK.secret, headers: headersOf(headers), body: Buffer.from(body), nowSeconds, toleranceSeconds: 300 });

describe("Slack request signatures", () => {
  it("matches Slack's worked example", () => {
    expect(signSlackRequest(SLACK)).toBe(SLACK.signature);
    expect(verifySlackWith(slackHeaders)).toEqual({ ok: true, webhookId: null });
    expect(verifySlackWith({ ...slackHeaders, "x-slack-signature": SLACK.signature.toUpperCase().replace("V0=", "v0=") }).ok).toBe(true);
  });

  it("rejects a changed body or timestamp", () => {
    expect(verifySlackWith(slackHeaders, `${SLACK.body}x`)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySlackWith({ ...slackHeaders, "x-slack-request-timestamp": String(SLACK.timestamp + 1) })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects timestamps outside five minutes either way", () => {
    expect(verifySlackWith(slackHeaders, SLACK.body, SLACK.timestamp + 301)).toEqual({ ok: false, reason: "stale" });
    expect(verifySlackWith(slackHeaders, SLACK.body, SLACK.timestamp - 301)).toEqual({ ok: false, reason: "stale" });
  });

  it("names missing and malformed headers", () => {
    expect(verifySlackWith({})).toEqual({ ok: false, reason: "missing" });
    expect(verifySlackWith({ "x-slack-signature": SLACK.signature })).toEqual({ ok: false, reason: "missing" });
    expect(verifySlackWith({ ...slackHeaders, "x-slack-request-timestamp": "soon" })).toEqual({ ok: false, reason: "malformed" });
    expect(verifySlackWith({ ...slackHeaders, "x-slack-signature": "v1=abc" })).toEqual({ ok: false, reason: "malformed" });
  });

  it("accepts signing secrets and refuses Slack API tokens", () => {
    expect(checkSlackSigningSecret(SLACK.secret)).toBe(SLACK.secret);
    expect(() => checkSlackSigningSecret("short")).toThrow();
    expect(() => checkSlackSigningSecret(`xoxb-${"1".repeat(40)}`)).toThrow(/Signing Secret/);
    expect(() => checkSlackSigningSecret(`xapp-${"1".repeat(40)}`)).toThrow(/Signing Secret/);
  });
});
