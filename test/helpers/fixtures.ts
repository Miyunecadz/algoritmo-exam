import request from 'supertest';
import { SEED_ORG_A, SEED_ORG_B } from '../../src/database/migrations/1700000000001-SeedOrgs';

export const ORG_A = SEED_ORG_A;
export const ORG_B = SEED_ORG_B;
/** Well-formed UUID that belongs to no organization — must behave exactly like another tenant's. */
export const ORG_UNKNOWN = '33333333-3333-3333-3333-333333333333';

export const asOrg = (baseUrl: string, orgId: string) => ({
  post: (path: string, body?: object) =>
    request(baseUrl)
      .post(path)
      .set('X-Org-Id', orgId)
      .send(body ?? {}),
  get: (path: string) => request(baseUrl).get(path).set('X-Org-Id', orgId),
  delete: (path: string) => request(baseUrl).delete(path).set('X-Org-Id', orgId),
});

/** Creates a bill and posts it, returning the bill id. */
export async function createPostedBill(
  baseUrl: string,
  orgId: string,
  amountDue: string,
): Promise<string> {
  const client = asOrg(baseUrl, orgId);
  const created = await client.post('/bills', { amountDue }).expect(201);
  await client.post(`/bills/${created.body.id}/post`).expect(200);
  return created.body.id as string;
}

/** Every money field in a response must be a string with exactly two decimals. */
export const MONEY_STRING = /^-?\d+\.\d{2}$/;
