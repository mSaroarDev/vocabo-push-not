/**
 * send-notifications.js
 */

require("dotenv").config();
const { Client } = require("pg");
const { initializeApp, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

// ---------- Config ----------
const DB_URL = process.env.DATABASE_URL;

if (!DB_URL) {
  throw new Error("DATABASE_URL is missing");
}

// ---------- Firebase Init ----------
let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
} catch (err) {
  throw new Error("Invalid GOOGLE_SERVICE_ACCOUNT JSON");
}

initializeApp({
  credential: cert(serviceAccount),
});

const messaging = getMessaging();

// ---------- Notification ----------
const NOTIFICATION = {
  title: "Vocabo-র নতুন অ্যাপ: আরও ফাস্ট, আরও সুন্দর!",
  description:
    "নতুন অ্যাপে থাকছে দারুণ সব সারপ্রাইজ ফিচার !  কোনো ঝামেলা ছাড়াই শেখা চালিয়ে যেতে একই অ্যাকাউন্ট নম্বর দিয়ে এখনই নতুন অ্যাপে লগইন করুন!",
};

// ---------- Helpers ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Main ----------
async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  let tokens = [];

  try {
    const result = await client.query(
      "SELECT token FROM push_notification_tokens WHERE token IS NOT NULL"
    );

    tokens = result.rows.map((row) => row.token).filter(Boolean);
  } finally {
    await client.end();
  }

  console.log(`Found ${tokens.length} token(s).\n`);

  if (tokens.length === 0) {
    console.log("No tokens to send to. Exiting.");
    return;
  }

  const BATCH_SIZE = 500;
  const DELAY_BETWEEN_BATCHES_MS = 300;
  const MAX_RETRIES = 5;
  const DELAY_BETWEEN_PASSES_MS = 2000;

  let pendingTokens = [...tokens];
  const allInvalidTokens = [];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (pendingTokens.length === 0) break;

    console.log(
      `--- Pass ${attempt}/${MAX_RETRIES} (${pendingTokens.length} tokens) ---\n`
    );

    const failedThisPass = [];
    let passSuccess = 0;
    let passFail = 0;

    for (let i = 0; i < pendingTokens.length; i += BATCH_SIZE) {
      const batch = pendingTokens.slice(i, i + BATCH_SIZE);

      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(pendingTokens.length / BATCH_SIZE);

      const message = {
        notification: {
          title: NOTIFICATION.title,
          body: NOTIFICATION.description,
        },
        tokens: batch,
      };

      let response;

      try {
        response = await messaging.sendEachForMulticast(message);
      } catch (err) {
        console.error(
          `  Batch ${batchNum}/${totalBatches} errored: ${err.message}`
        );
        passFail += batch.length;
        failedThisPass.push(...batch);
        if (i + BATCH_SIZE < pendingTokens.length)
          await sleep(DELAY_BETWEEN_BATCHES_MS);
        continue;
      }

      passSuccess += response.successCount;
      passFail += response.failureCount;

      console.log(
        `  Batch ${batchNum}/${totalBatches}: ${response.successCount} sent, ${response.failureCount} failed`
      );

      for (let j = 0; j < response.responses.length; j++) {
        const res = response.responses[j];
        if (!res.success) {
          const token = batch[j];
          failedThisPass.push(token);
          const code = res.error?.code;

          if (
            code === "messaging/invalid-registration-token" ||
            code === "messaging/registration-token-not-registered"
          ) {
            allInvalidTokens.push(token);
          }
        }
      }

      if (i + BATCH_SIZE < pendingTokens.length) {
        await sleep(DELAY_BETWEEN_BATCHES_MS);
      }
    }

    console.log(
      `\n  Pass ${attempt} result: ${passSuccess} sent, ${passFail} failed`
    );

    if (failedThisPass.length === 0) {
      console.log("  All tokens delivered successfully.\n");
      break;
    }

    pendingTokens = failedThisPass;

    if (attempt < MAX_RETRIES) {
      console.log(
        `  Waiting ${DELAY_BETWEEN_PASSES_MS}ms before next pass...\n`
      );
      await sleep(DELAY_BETWEEN_PASSES_MS);
    }
  }

  const totalTokens = tokens.length;
  const finalSuccess = totalTokens - pendingTokens.length;
  const finalFailure = pendingTokens.length;

  console.log(
    `\n=== Final: ${finalSuccess} delivered, ${finalFailure} failed after ${MAX_RETRIES} passes ===`
  );

  if (allInvalidTokens.length > 0) {
    const finalInvalidTokens = allInvalidTokens.filter((t) =>
      pendingTokens.includes(t)
    );
    const uniqueInvalid = [...new Set(finalInvalidTokens)];

    if (uniqueInvalid.length > 0) {
      console.log(
        `\nCleaning up ${uniqueInvalid.length} permanently invalid token(s) from DB...`
      );

      const cleanupClient = new Client({ connectionString: DB_URL });
      try {
        await cleanupClient.connect();
        const res = await cleanupClient.query(
          "DELETE FROM push_notification_tokens WHERE token = ANY($1)",
          [uniqueInvalid]
        );
        console.log(`Removed ${res.rowCount} invalid token(s) from DB.`);
      } catch (err) {
        console.error(`Cleanup failed: ${err.message}`);
      } finally {
        await cleanupClient.end();
      }
    }
  }
}

// ---------- Run ----------
if (require.main === module) {
  main().catch((err) => {
    console.error("Script failed:", err);
    process.exit(1);
  });
}

module.exports = { main };
