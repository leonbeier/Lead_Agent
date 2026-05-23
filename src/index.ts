import { startServer } from "./server";

process.on("unhandledRejection", (reason) => {
	console.error("Unhandled promise rejection", reason);
});

startServer();