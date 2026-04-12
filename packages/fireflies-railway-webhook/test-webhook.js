const fetch = require('node-fetch');

const WEBHOOK_URL =
  'https://fireflies-webhook-production-3f5d.up.railway.app/fireflies-webhook';
const HEALTH_URL =
  'https://fireflies-webhook-production-3f5d.up.railway.app/healthz';

async function testWebhookPost() {
  console.log('\n=== POST /fireflies-webhook ===\n');
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meetingId: 'test-meeting-123',
      organizerEmail: 'josh@salesglidergrowth.com',
    }),
  });
  const bodyText = await res.text();
  console.log('The HTTP status code returned:', res.status);
  console.log('The response body:', bodyText);
  console.log('Check Railway logs for async processing output');
}

async function testHealthz() {
  console.log('\n=== GET /healthz ===\n');
  const res = await fetch(HEALTH_URL, { method: 'GET' });
  const bodyText = await res.text();
  console.log('The HTTP status code returned:', res.status);
  console.log('The response body:', bodyText);
  const isOk = bodyText.trim() === 'ok';
  console.log(`Health check returns "ok": ${isOk}`);
}

async function main() {
  await testWebhookPost();
  await testHealthz();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
