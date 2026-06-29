require("dotenv").config();
const cron = require("node-cron");
const http = require("http");
const { main } = require("./send-notifications");

const PORT = process.env.PORT || 8050;

const job = () => {
  const now = new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" });
  console.log(`[${now}] Running scheduled notification job...`);
  main().catch((err) => console.error("Scheduled job failed:", err));
};

const opts = { timezone: "Asia/Dhaka" };

cron.schedule("0 11,14,16,21 * * *", job, opts);
cron.schedule("8 21 * * * ", job, opts);

http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Push notification server is running\n");
}).listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log("Cron schedule: 11:00, 14:00, 16:00, 21:00 Asia/Dhaka (GMT+6)");
});
