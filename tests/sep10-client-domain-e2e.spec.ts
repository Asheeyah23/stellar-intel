import { describe, it, expect, vi, beforeAll, afterEach, afterAll, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { NextRequest } from 'next/server';
import { Keypair, Networks, Transaction, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import {
  authenticate,
  invalidateSep10Token,
  Sep10AuthError,
  Sep10ChallengeRejectedError,
} from '@/lib/stellar/sep10';
import { clearRateLimitStore } from '@/lib/api/rate-limit';
import { clearTomlCache } from '@/lib/stellar/toml-cache';
import { GET as getOurStellarToml } from '@/app/.well-known/stellar.toml/route';
import { POST as postClientDomainRoute } from '@/app/api/sep10/client-domain/route';
import type { ResolvedAnchor } from '@/types';

// Mock freighter-api before imports evaluate
vi.mock('@stellar/freighter-api', () => ({
  signTransaction: vi.fn(),
  getNetwork: vi.fn(async () => ({
    error: false,
    network: '',
    networkPassphrase: Networks.PUBLIC,
  })),
}));

import { signTransaction } from '@stellar/freighter-api';

// Register the fake anchor in ANCHORS so the co-sign route accepts its homeDomain
vi.mock('@/constants/anchors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/constants/anchors')>();
  return {
    ...actual,
    ANCHORS: [
      ...actual.ANCHORS,
      {
        id: 'fake-anchor',
        name: 'Fake Anchor',
        homeDomain: 'anchor.example',
        serviceDomain: 'anchor.example',
        corridors: [],
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        seps: ['sep10'],
        sep10ClientDomain: true,
      },
    ],
  };
});

const HOME_DOMAIN = 'anchor.example';
const OUR_DOMAIN = 'stellarintel.test';
const JWT = `${btoa('{"alg":"HS256"}')}.${btoa(
  JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
)}.signature`;

const anchorServerKeypair = Keypair.random();
const ourSigningKeypair = Keypair.random();
const clientKeypair = Keypair.random();

function buildFakeAnchor(): ResolvedAnchor {
  return {
    id: 'fake-anchor',
    name: 'Fake Anchor',
    homeDomain: HOME_DOMAIN,
    domain: HOME_DOMAIN,
    corridors: [],
    assetCode: 'USDC',
    assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    sep10ClientDomain: true,
    WEB_AUTH_ENDPOINT: `https://${HOME_DOMAIN}/auth`,
    SIGNING_KEY: anchorServerKeypair.publicKey(),
    capabilities: {
      sep10: true,
      sep24: false,
      sep38: false,
      sep12: false,
      sep6: false,
      sep31: false,
    },
    TRANSFER_SERVER: null,
    TRANSFER_SERVER_SEP0024: null,
    DIRECT_PAYMENT_SERVER: null,
    ANCHOR_QUOTE_SERVER: null,
    NETWORK_PASSPHRASE: Networks.PUBLIC,
    ORG_URL: null,
    ORG_SUPPORT_EMAIL: null,
    ORG_SUPPORT_URL: null,
    CURRENCIES: [],
    seps: ['sep10'],
  };
}

async function extractSigningKeyFromOurToml(): Promise<string | null> {
  const response = await getOurStellarToml();
  const text = await response.text();
  const match = text.match(/SIGNING_KEY\s*=\s*"([^"]+)"/);
  return match ? (match[1] ?? null) : null;
}

let overrideChallengeClientDomain: string | null = null;
let cachedOurSigningKey: string | null = null;

const handlers = [
  // 1. Fake anchor stellar.toml
  http.get(`https://${HOME_DOMAIN}/.well-known/stellar.toml`, () => {
    const toml =
      [
        'VERSION = "2.0.0"',
        `SIGNING_KEY = "${anchorServerKeypair.publicKey()}"`,
        `WEB_AUTH_ENDPOINT = "https://${HOME_DOMAIN}/auth"`,
        `NETWORK_PASSPHRASE = "${Networks.PUBLIC}"`,
      ].join('\n') + '\n';

    return new HttpResponse(toml, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }),

  // 2. Fake anchor GET /auth (builds challenge with client_domain and key read from our toml)
  http.get(`https://${HOME_DOMAIN}/auth`, async ({ request }) => {
    const url = new URL(request.url);
    const account = url.searchParams.get('account');
    const clientDomainParam = url.searchParams.get('client_domain');
    if (!account) {
      return HttpResponse.json({ error: 'Missing account' }, { status: 400 });
    }

    const tomlSigningKey = await extractSigningKeyFromOurToml();
    if (tomlSigningKey) {
      cachedOurSigningKey = tomlSigningKey;
    }
    const ourSigningKey = tomlSigningKey ?? cachedOurSigningKey;
    const effectiveClientDomain = overrideChallengeClientDomain ?? clientDomainParam ?? null;

    const challengeXdr = WebAuth.buildChallengeTx(
      anchorServerKeypair,
      account,
      HOME_DOMAIN,
      300,
      Networks.PUBLIC,
      HOME_DOMAIN,
      null,
      effectiveClientDomain,
      ourSigningKey ?? undefined
    );

    return HttpResponse.json({
      transaction: challengeXdr,
      network_passphrase: Networks.PUBLIC,
    });
  }),

  // 3. Fake anchor POST /auth (verifies signatures and returns JWT only if both signers present)
  http.post(`https://${HOME_DOMAIN}/auth`, async ({ request }) => {
    const body = (await request.json()) as { transaction?: string };
    if (!body.transaction || typeof body.transaction !== 'string') {
      return HttpResponse.json({ error: 'Missing transaction parameter' }, { status: 400 });
    }

    const tomlSigningKey = await extractSigningKeyFromOurToml();
    if (tomlSigningKey) {
      cachedOurSigningKey = tomlSigningKey;
    }
    const ourSigningKey = tomlSigningKey ?? cachedOurSigningKey;
    if (!ourSigningKey) {
      return HttpResponse.json(
        { error: 'Client domain signing key not configured in toml' },
        { status: 400 }
      );
    }

    try {
      const verifiedSigners = WebAuth.verifyChallengeTxSigners(
        body.transaction,
        anchorServerKeypair.publicKey(),
        Networks.PUBLIC,
        [clientKeypair.publicKey(), ourSigningKey],
        HOME_DOMAIN,
        HOME_DOMAIN
      );

      // WebAuth.verifyChallengeTxSigners verifies both serverKey and ourSigningKey (from client_domain op),
      // and returns verified client signers. Ensure clientKeypair is among them.
      if (!verifiedSigners.includes(clientKeypair.publicKey())) {
        return HttpResponse.json({ error: 'Missing clientAccount signature' }, { status: 400 });
      }

      return HttpResponse.json({ token: JWT });
    } catch (err) {
      return HttpResponse.json(
        { error: err instanceof Error ? err.message : 'Signature verification failed' },
        { status: 400 }
      );
    }
  }),

  // 4. Our co-signing route (route the fetch to app/api/sep10/client-domain/route.ts)
  http.post('*/api/sep10/client-domain', async ({ request }) => {
    const body = await request.text();
    const nextReq = new NextRequest('http://localhost/api/sep10/client-domain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return await postClientDomainRoute(nextReq);
  }),
];

const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  clearRateLimitStore();
  clearTomlCache();
  invalidateSep10Token(HOME_DOMAIN, clientKeypair.publicKey());
  overrideChallengeClientDomain = null;
  cachedOurSigningKey = null;
});

afterAll(() => server.close());

beforeEach(() => {
  vi.stubEnv('CLIENT_DOMAIN', OUR_DOMAIN);
  vi.stubEnv('CLIENT_DOMAIN_SIGNING_SECRET', ourSigningKeypair.secret());
  vi.stubEnv('NEXT_PUBLIC_SEP10_CLIENT_DOMAIN', OUR_DOMAIN);
  cachedOurSigningKey = ourSigningKeypair.publicKey();

  // Freighter default mock: signs the transaction with client keypair
  vi.mocked(signTransaction).mockImplementation(async (xdr: string) => {
    const tx = TransactionBuilder.fromXDR(xdr, Networks.PUBLIC) as Transaction;
    tx.sign(clientKeypair);
    return {
      signedTxXdr: tx.toXDR(),
      signerAddress: clientKeypair.publicKey(),
    };
  });
});

describe('SEP-10 client_domain end-to-end against fake anchor (#1330)', () => {
  it('happy path returns a JWT after full round-trip verification', async () => {
    const auth = await authenticate(buildFakeAnchor(), clientKeypair.publicKey());

    expect(auth.jwt).toBe(JWT);
    expect(auth.anchorDomain).toBe(HOME_DOMAIN);
    expect(auth.publicKey).toBe(clientKeypair.publicKey());
    expect(signTransaction).toHaveBeenCalledTimes(1);

    // Verify the transaction handed to Freighter already carried the server and co-signer signatures
    const callArgs = vi.mocked(signTransaction).mock.calls[0];
    const xdrHandedToFreighter = callArgs?.[0];
    expect(xdrHandedToFreighter).toBeDefined();

    const txHandedToFreighter = TransactionBuilder.fromXDR(
      xdrHandedToFreighter!,
      Networks.PUBLIC
    ) as Transaction;
    expect(txHandedToFreighter.signatures).toHaveLength(2);
  });

  it('fails with ANC061 error when the co-sign route is unconfigured', async () => {
    // Unconfigure server-side client_domain signing secret so the route returns 503
    vi.stubEnv('CLIENT_DOMAIN_SIGNING_SECRET', '');

    await expect(authenticate(buildFakeAnchor(), clientKeypair.publicKey())).rejects.toEqual(
      expect.objectContaining({
        name: 'Sep10AuthError',
        status: 503,
        message: 'SEP-10 client-domain co-sign failed: HTTP 503',
      })
    );

    // Freighter must never be invoked if co-signing fails
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('fails with ANC061 error when NEXT_PUBLIC_SEP10_CLIENT_DOMAIN is not configured', async () => {
    // Unconfigure client-side client_domain
    vi.stubEnv('NEXT_PUBLIC_SEP10_CLIENT_DOMAIN', '');

    await expect(authenticate(buildFakeAnchor(), clientKeypair.publicKey())).rejects.toEqual(
      expect.objectContaining({
        name: 'Sep10AuthError',
        message:
          'This anchor requires SEP-10 client_domain, which is not configured on this deployment.',
      })
    );

    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('fails before Freighter is called if the anchor inserts a different client_domain', async () => {
    // Anchor inserts a mismatched client_domain
    overrideChallengeClientDomain = 'malicious.example';

    await expect(authenticate(buildFakeAnchor(), clientKeypair.publicKey())).rejects.toThrow(
      Sep10ChallengeRejectedError
    );

    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('fails at anchor POST /auth if the challenge lacks the client_domain co-signature', async () => {
    // Simulate Freighter signing an initial challenge directly without co-signing
    const challengeXdr = WebAuth.buildChallengeTx(
      anchorServerKeypair,
      clientKeypair.publicKey(),
      HOME_DOMAIN,
      300,
      Networks.PUBLIC,
      HOME_DOMAIN,
      null,
      OUR_DOMAIN,
      ourSigningKeypair.publicKey()
    );

    const tx = TransactionBuilder.fromXDR(challengeXdr, Networks.PUBLIC) as Transaction;
    // Only sign with client keypair, omitting ourSigningKeypair
    tx.sign(clientKeypair);

    const res = await fetch(`https://${HOME_DOMAIN}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: tx.toXDR() }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain(
      "Transaction not signed by the source account of the 'client_domain'"
    );
  });
});
