#!/usr/bin/env node

const { spawnSync } = require("child_process");
const https = require("https");
const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "config.json");

if (!fs.existsSync(configPath)) {
	console.error("ERROR: config.json не найден рядом с main.js");
	process.exit(1);
}

const {
	projects,
	user: globalUser,
	password: globalPassword,
	telegramBotToken,
	telegramChatId,
} = JSON.parse(fs.readFileSync(configPath, "utf8"));

function sendTelegram(text) {
	if (!telegramBotToken || !telegramChatId) return;

	const body = JSON.stringify({
		chat_id: telegramChatId,
		text,
		parse_mode: "HTML",
	});

	const req = https.request(
		{
			hostname: "api.telegram.org",
			path: `/bot${telegramBotToken}/sendMessage`,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(body),
			},
		},
		(res) => {
			if (res.statusCode !== 200) {
				let data = "";
				res.on("data", (chunk) => (data += chunk));
				res.on("end", () =>
					console.log(`[telegram] Ошибка (${res.statusCode}): ${data}`),
				);
			}
		},
	);

	req.on("error", (err) => console.log(`[telegram] ${err.message}`));
	req.end(body);
}

const gate = () => new Date().toISOString().replace("T", " ").slice(0, 19);

const log = (projectDir, msg) =>
	console.log(`[${gate()}] [${projectDir}] ${msg}`);

function checkAndDeploy() {
	for (const project of projects) {
		const {
			dir,
			branch,
			user = globalUser,
			password = globalPassword,
			commands,
		} = project;

		function run(cmd, opts = {}) {
			return spawnSync(cmd, {
				shell: true,
				encoding: "utf8",
				cwd: dir,
				...opts,
			});
		}

		if (!fs.existsSync(dir)) {
			log(dir, `ERROR: Директория не найдена`);
			continue;
		}

		const remoteResult = run("git remote get-url origin");
		const remoteUrl = remoteResult.stdout.trim();

		let pullCmd;
		if (user && password && remoteUrl.startsWith("https://")) {
			const authedUrl = remoteUrl.replace(
				"https://",
				`https://${user}:${password}@`,
			);

			const branchPart = branch ? `${branch}` : "";

			pullCmd = `git pull ${authedUrl}${branchPart}`;
		} else {
			pullCmd = branch ? `git pull origin ${branch}` : "git pull";
		}

		log(dir, `Запуск git pull${branch ? ` origin ${branch}` : ""}...`);

		const pull = run(pullCmd);
		const output = (pull.stdout + pull.stderr).trim();
		log(dir, output);

		if (pull.status !== 0) {
			log(dir, `ERROR: git pull завершился с ошибкой (код ${pull.status})`);
			sendTelegram(
				`❌ <b>${dir}</b>\ngit pull ошибка (код ${pull.status})\n\n<pre>${output.slice(0, 500)}</pre>`,
			);

			continue;
		}

		if (output.includes("Already up to date.")) {
			log(dir, "Изменений нет. Команды не запускаются.");
			continue;
		}

		log(dir, "Есть изменения! Запуск команд...");
		sendTelegram(`🚀 <b>${dir}</b>\nОбнаружены изменения, начинаю деплой...`);

		let failed = false;
		for (const cmd of commands) {
			log(dir, `>>> ${cmd}`);
			const result = run(cmd, { stdio: "inherit" });
			if (result.status !== 0) {
				log(
					dir,
					`ERROR: Команда завершилась с ошибкой (код ${result.status}): ${cmd}`,
				);
				sendTelegram(
					`❌ <b>${dir}</b>\nОшибка при выполнении:\n<pre>${cmd}</pre>\nКод: ${result.status}`,
				);
				failed = true;
				break;
			}

			log(dir, `OK: ${cmd}`);
		}

		if (!failed) {
			log(dir, "Деплой завершён успешно.");
			sendTelegram(`✅ <b>${dir}</b>\nДеплой завершён успешно.`);
		}
	}
}

const INTERVAL_MS = 60 * 1000; // 1 минута

console.log(`[git-watcher] Запущен. Проверка каждые ${INTERVAL_MS / 1000}с.`);

setInterval(checkAndDeploy, INTERVAL_MS).unref();
