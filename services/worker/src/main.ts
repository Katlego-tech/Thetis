function logHealth() {
  console.log(JSON.stringify({ status: "ok", service: "worker" }));
}

const healthTimer = setInterval(logHealth, 60_000);
process.once("SIGTERM", () => clearInterval(healthTimer));
logHealth();
