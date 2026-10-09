// CALLAUNCHER — per-instance Java only, PrismLauncher Java runtimes when available,
// settings.json (C-style), download workers, no Blessed, full menus, auth, manifest, launch.
import { Authflow } from "prismarine-auth";
import cliProgress from "cli-progress";
import os from "os";
import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import https from "https";
import readline from "readline";
import { spawn } from "child_process";
import AdmZip from "adm-zip";
import Fuse from "fuse.js";
// ---------- PrismLauncher Java metadata ----------
const PRISM_META_BASE = "https://meta.prismlauncher.org/v1";
const PRISM_AZUL_UID = "com.azul.java";

// ---------- Mojang version manifest ----------
const MOJANG_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

// ---------- Base paths ----------
const BASE_DIR = path.join(os.homedir(), ".callum-launcher");
const VERSIONS_DIR = path.join(BASE_DIR, "installed-jars");
const ASSETS_DIR = path.join(BASE_DIR, "assets");
const ASSET_OBJECTS_DIR = path.join(ASSETS_DIR, "objects");
const ASSET_INDEXES_DIR = path.join(ASSETS_DIR, "indexes");
const SETTINGS_PATH = path.join(BASE_DIR, "settings.json");
const AUTH_CACHE_PATH = path.join(BASE_DIR, "auth_cache.json");

for (const dir of [BASE_DIR, VERSIONS_DIR, ASSETS_DIR, ASSET_OBJECTS_DIR, ASSET_INDEXES_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
}

// ---------- Box message ----------
function BoxMsg(msg) {
    const lines = msg.split("\n");
    const width = Math.max(...lines.map(l => l.length));
    const top = "╭" + "─".repeat(width + 2) + "╮";
    const bottom = "╰" + "─".repeat(width + 2) + "╯";

    console.log(top);
    for (const line of lines) {
        console.log("│ " + line.padEnd(width) + " │");
    }
    console.log(bottom);
}

// ---------- Java bin finder ----------
function findJavaBin(root) {
    if (!fs.existsSync(root)) return null;

    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
        const full = path.join(root, e.name);

        if (e.isDirectory()) {
            const candidate =
                process.platform === "win32"
                    ? path.join(full, "bin", "java.exe")
                    : path.join(full, "bin", "java");

            if (fs.existsSync(candidate)) return candidate;

            const deeper = findJavaBin(full);
            if (deeper) return deeper;
        }
    }
    return null;
}

// ---------- Settings (C-style perInstanceJava) ----------
function loadSettings() {
    if (!fs.existsSync(SETTINGS_PATH)) {
        return {
            downloadWorkers: 8,
            perInstanceJava: [] // [{version, path, addedAt}]
        };
    }
    try {
        const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
        const parsed = JSON.parse(raw);
        return {
            downloadWorkers: parsed.downloadWorkers ?? 4,
            perInstanceJava: Array.isArray(parsed.perInstanceJava) ? parsed.perInstanceJava : []
        };
    } catch {
        return {
            downloadWorkers: 4,
            perInstanceJava: []
        };
    }
}

function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}

let SETTINGS = loadSettings();

function getPerInstanceJava(versionId) {
    return SETTINGS.perInstanceJava.find(e => e.version === versionId) || null;
}

function setPerInstanceJava(versionId, pathStr) {
    const existing = SETTINGS.perInstanceJava.find(e => e.version === versionId);
    const now = Math.floor(Date.now() / 1000);
    if (existing) {
        existing.path = pathStr;
        existing.addedAt = now;
    } else {
        SETTINGS.perInstanceJava.push({ version: versionId, path: pathStr, addedAt: now });
    }
    saveSettings(SETTINGS);
}

function removePerInstanceJava(versionId) {
    SETTINGS.perInstanceJava = SETTINGS.perInstanceJava.filter(e => e.version !== versionId);
    saveSettings(SETTINGS);
}

// ---------- Helpers ----------
function ask(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise(resolve =>
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim());
        })
    );
}

async function fetchJSON(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        return await res.json();
    } catch (err) {
        throw new Error(`Failed to fetch JSON from ${url}: ${err.message}`);
    }
}

// single-file download with progress bar
async function downloadFileWithProgress(url, dest, label = "[file]") {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });

    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);

        https.get(url, response => {
            if (response.statusCode !== 200) {
                file.close(() => fs.unlink(dest, () => {}));
                reject(new Error(`HTTP ${response.statusCode} for ${url}`));
                return;
            }

            const total = parseInt(response.headers["content-length"] || "0", 10);
            const bar = new cliProgress.SingleBar(
                {
                    clearOnComplete: true,
                    hideCursor: true,
                    format: `${label} {bar} {percentage}% | {value}/{total} bytes`
                },
                cliProgress.Presets.shades_classic
            );
            if (total > 0) bar.start(total, 0);

            let downloaded = 0;
            response.on("data", chunk => {
                downloaded += chunk.length;
                if (total > 0) bar.update(downloaded);
            });

            response.pipe(file);
            file.on("finish", () => {
                file.close(() => {
                    if (total > 0) bar.stop();
                    resolve();
                });
            });
        }).on("error", err => {
            file.close(() => fs.unlink(dest, () => {}));
            reject(err);
        });
    });
}

// legacy multi-file download queue with files-per-second
async function downloadFile(url, dest) {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });

    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);

        https.get(url, response => {
            if (response.statusCode !== 200) {
                file.close(() => fs.unlink(dest, () => {}));
                reject(new Error(`HTTP ${response.statusCode} for ${url}`));
                return;
            }

            response.pipe(file);
            file.on("finish", () => file.close(resolve));
        }).on("error", err => {
            file.close(() => fs.unlink(dest, () => {}));
            reject(err);
        });
    });
}

async function isFileValid(filePath, expected = {}) {
    try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) return false;
        if (Number.isFinite(expected.size) && stat.size !== expected.size) return false;
        if (!expected.sha1) return true;
        if (typeof expected.sha1 !== "string" || !/^[a-f0-9]{40}$/i.test(expected.sha1)) return false;

        const hash = createHash("sha1");
        await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(filePath);
            stream.on("data", chunk => hash.update(chunk));
            stream.on("error", reject);
            stream.on("end", resolve);
        });
        return hash.digest("hex").toLowerCase() === expected.sha1.toLowerCase();
    } catch (err) {
        if (err.code === "ENOENT") return false;
        throw err;
    }
}

async function getJobsNeedingDownload(jobs, workers) {
    const invalid = [];
    let index = 0;

    async function worker() {
        while (index < jobs.length) {
            const job = jobs[index++];
            if (!await isFileValid(job.dest, job.expected)) invalid.push(job);
        }
    }

    await Promise.all(
        Array.from({ length: Math.max(1, Math.min(workers, jobs.length)) }, worker)
    );
    return invalid;
}

// ---------- Download workers (with files-per-second) ----------
async function runDownloadQueue(jobs, name, workers) {
    if (jobs.length === 0) {
        console.log(`${name} All items already present.`);
        return;
    }
	else {
		console.log(`${name} Calculating total disk space usage...`);

		const sizeBar = new cliProgress.SingleBar(
			{
				clearOnComplete: true,
				hideCursor: true,
				format: `${name} [calc] {bar} {percentage}% | {value}/{total} files`
			},
			cliProgress.Presets.shades_classic
		);

		sizeBar.start(jobs.length, 0);

		let totalBytes = 0;
		let completed = 0;

		// Create an array of promises, but each promise updates the bar when done
		const sizePromises = jobs.map(job =>
			getRemoteFileSize(job.url)
				.then(size => {
					totalBytes += size;
				})
				.catch(() => {
					// treat as 0
				})
				.finally(() => {
					completed++;
					sizeBar.update(completed);
				})
		);

		// Wait for all HEAD requests to finish
		await Promise.all(sizePromises);

		sizeBar.stop();

		const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
		console.log(`${name} Need to get ${totalMB} MB of data...\n`);
		console.log(`${name} Downloading ${jobs.length} files with ${workers} workers...`);
	}

    const bar = new cliProgress.SingleBar(
        {
            clearOnComplete: true,
            hideCursor: true,
            format: `${name} {bar} {percentage}% | {value}/{total} files | {fps} files/s`
        },
        cliProgress.Presets.shades_grey
    );
    bar.start(jobs.length, 0);

    let index = 0;
    let completed = 0;
    const startTime = Date.now();
    const failures = [];

    async function worker() {
        while (true) {
            let job;
            if (index >= jobs.length) break;
            job = jobs[index++];
            try {
                await downloadFile(job.url, job.dest);
                if (!await isFileValid(job.dest, job.expected)) {
                    await fs.promises.unlink(job.dest).catch(() => {});
                    throw new Error("Downloaded file failed integrity validation.");
                }
            } catch (err) {
                console.error(`\n${name} Failed: ${job.url} -> ${err.message}`);
                failures.push(`${job.dest}: ${err.message}`);
            }
            completed++;
            const elapsedSec = (Date.now() - startTime) / 1000;
            const fps = elapsedSec > 0 ? (completed / elapsedSec).toFixed(2) : "0.00";
            bar.update(completed, { fps });
        }
    }

    const count = Math.max(1, Math.min(workers, jobs.length));
    const promises = [];
    for (let i = 0; i < count; i++) {
        promises.push(worker());
    }
    await Promise.all(promises);
    bar.stop();
    if (failures.length > 0) {
        throw new Error(`${name} ${failures.length} download(s) failed:\n${failures.join("\n")}`);
    }
	else {
		console.log(`${name} All downloads completed successfully.`);
	}
    console.log(`${name} Done.`);
}

// ---------- Version parsing ----------
function parseVersionId(id) {
    const parts = id.split(".").map(n => parseInt(n, 10));
    while (parts.length < 3) parts.push(0);
    return parts;
}

function isAtLeast(versionId, minId) {
    const a = parseVersionId(versionId);
    const b = parseVersionId(minId);
    for (let i = 0; i < 3; i++) {
        if (a[i] > b[i]) return true;
        if (a[i] < b[i]) return false;
    }
    return true;
}

// ---------- OS → PrismLauncher runtimeOS ----------
function detectPrismRuntimeOS() {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === "win32") return "windows-x64";
    if (platform === "linux") return "linux-x64";
    if (platform === "darwin") {
        if (arch === "arm64") return "mac-os-arm64";
        return "mac-os-x64";
    }

    return "windows-x64";
}

// ---------- Java validation ----------
async function validateJavaPath(javaPath) {
    return new Promise(resolve => {
        try {
            const proc = spawn(javaPath, ["-version"]);
            let done = false;
            proc.on("exit", () => {
                done = true;
                resolve(true);
            });
            proc.on("error", () => resolve(false));
            setTimeout(() => {
                if (!done) resolve(true);
            }, 1000);
        } catch {
            resolve(false);
        }
    });
}

// ---------- PrismLauncher Java downloader (Azul provider) ----------
async function downloadPrismAzulJava(versionId, requiredMajor) {
    const versionDir = path.join(VERSIONS_DIR, versionId);
    const runtimeDir = path.join(versionDir, "java-azul");

    const existing = findJavaBin(runtimeDir);
    if (existing) {
        console.log("[java] Existing PrismLauncher Azul runtime found.");
        return existing;
    }

    console.log(`[java] Using PrismLauncher Azul metadata for Java ${requiredMajor}...`);

    let provider;
    try {
        provider = await fetchJSON(`${PRISM_META_BASE}/${PRISM_AZUL_UID}`);
    } catch (err) {
        console.error("[java] Failed to fetch PrismLauncher Azul provider manifest:", err.message);
        return null;
    }

    const versions = provider.versions || [];
    const targetId = `java${requiredMajor}`;
    const entry = versions.find(v => v.version === targetId);
    if (!entry) {
        console.error(`[java] PrismLauncher Azul provider has no version '${targetId}'.`);
        return null;
    }

    let vManifest;
    try {
        vManifest = await fetchJSON(`${PRISM_META_BASE}/${PRISM_AZUL_UID}/${targetId}.json`);
    } catch (err) {
        console.error("[java] Failed to fetch PrismLauncher Azul version manifest:", err.message);
        return null;
    }

    const runtimes = vManifest.runtimes || [];
    const runtimeOS = detectPrismRuntimeOS();
    const rt = runtimes.find(r => r.runtimeOS === runtimeOS);
    if (!rt) {
        console.error(`[java] No runtime for OS '${runtimeOS}' in PrismLauncher Azul Java ${requiredMajor}.`);
        return null;
    }

    const url = rt.url;
    if (!url) {
        console.error("[java] Runtime entry has no URL.");
        return null;
    }

    console.log(`[java] Downloading Azul Java ${requiredMajor} from PrismLauncher: ${url}`);

    const tmpZip = path.join(versionDir, `azul-${requiredMajor}.zip`);

    try {
        await downloadFileWithProgress(url, tmpZip, `[java ${requiredMajor}]`);
    } catch (err) {
        console.error("[java] Failed to download Azul ZIP:", err.message);
        return null;
    }

    try {
        await fs.promises.mkdir(runtimeDir, { recursive: true });
        const zip = new AdmZip(tmpZip);
        zip.extractAllTo(runtimeDir, true);
    } catch (err) {
        console.error("[java] Failed to extract Azul ZIP:", err.message);
        return null;
    } finally {
        fs.unlink(tmpZip, () => {});
    }

    const found = findJavaBin(runtimeDir);
    if (!found) {
        console.error("[java] Could not locate java binary in extracted Azul runtime.");
        return null;
    }

    console.log("[java] PrismLauncher Azul Java downloaded! PATH:", found);
    return found;
}

// ---------- Java selection logic (PER INSTANCE ONLY) ----------
function requiredJavaMajorFor(versionId, metadata) {
    if (metadata?.javaVersion?.majorVersion) {
        return metadata.javaVersion.majorVersion;
    }

    if (isAtLeast(versionId, "1.20.5")) return 21;
    if (isAtLeast(versionId, "1.17")) return 17;
    return 8;
}

async function ensureJavaRuntime(versionId, metadata) {
    const entry = getPerInstanceJava(versionId);
    if (entry) {
        if (await validateJavaPath(entry.path)) {
            console.log(`[java] Using saved per-instance Java for ${versionId}.`);
            return entry.path;
        } else {
            console.log(`[java] Saved per-instance Java for ${versionId} is invalid. Removing.`);
            removePerInstanceJava(versionId);
        }
    }

    const major = requiredJavaMajorFor(versionId, metadata);
    const azul = await downloadPrismAzulJava(versionId, major);
    if (azul && await validateJavaPath(azul)) {
        console.log(`[java] Using downloaded PrismLauncher Azul Java ${major} for ${versionId}.`);
        return azul;
    }

    console.log("\n[java] No valid Java runtime found.");
    console.log(`You must provide a Java executable path for version ${versionId}.`);

    while (true) {
        const userPath = await ask("Enter full path to your Java executable: ");
        if (!userPath) {
            console.log("No Java path entered. Aborting launch.");
            return null;
        }

        if (await validateJavaPath(userPath)) {
            setPerInstanceJava(versionId, userPath);
            console.log("[java] Saved per-instance Java for this version.");
            return userPath;
        } else {
            console.log("That Java path did not work. Try again.");
        }
    }
}

// ---------- Library path helper ----------
function getLibraryPath(lib, artifact) {
    if (artifact.path) return artifact.path;

    const [group, name, version] = lib.name.split(":");
    const groupPath = group.replace(/\./g, "/");
    const fileName = `${name}-${version}.jar`;
    return `${groupPath}/${name}/${version}/${fileName}`;
}

// ---------- Libraries (per version) ----------
async function downloadLibraries(metadata, versionId) {
    const libs = metadata.libraries || [];
    console.log(`\n[+] Libraries to download: ${libs.length}`);

    const versionLibDir = path.join(VERSIONS_DIR, versionId, "libraries");
    await fs.promises.mkdir(versionLibDir, { recursive: true });

    const jobs = [];
    for (const lib of libs) {
        const artifact = lib.downloads?.artifact;
        if (!artifact?.url) continue;

        const relPath = getLibraryPath(lib, artifact);
        const dest = path.join(versionLibDir, relPath);

        jobs.push({
            url: artifact.url,
            dest,
            expected: { sha1: artifact.sha1, size: artifact.size }
        });
    }

    const needed = await getJobsNeedingDownload(jobs, SETTINGS.downloadWorkers);
    await runDownloadQueue(needed, "[libs]", SETTINGS.downloadWorkers);
}

// ---------- Natives (legacy-style only) ----------
async function downloadAndExtractNatives(metadata, versionId) {
    const libs = metadata.libraries || [];
    const versionDir = path.join(VERSIONS_DIR, versionId);
    const nativesDir = path.join(versionDir, "natives");
    const tempDir = path.join(versionDir, "natives-temp");

    await fs.promises.mkdir(nativesDir, { recursive: true });
    await fs.promises.mkdir(tempDir, { recursive: true });

    const nativeEntries = [];

    for (const lib of libs) {
        const classifiers = lib.downloads?.classifiers;
        if (!classifiers) continue;

        const keys = Object.keys(classifiers).filter(k =>
            k.startsWith("natives-windows") ||
            k.startsWith("natives-linux") ||
            k.startsWith("natives-osx")
        );
        for (const key of keys) {
            const info = classifiers[key];
            if (!info?.url) continue;
            nativeEntries.push({ info });
        }
    }

    if (nativeEntries.length === 0) {
        console.log("[natives] No natives exist for this version.");
        return;
    }

    console.log(`\n[+] Native JARs to download & extract: ${nativeEntries.length}`);

    const jobs = [];
    for (const { info } of nativeEntries) {
        const jarName = path.basename(info.path || "natives.jar");
        const jarPath = path.join(tempDir, jarName);
        jobs.push({
            url: info.url,
            dest: jarPath,
            expected: { sha1: info.sha1, size: info.size }
        });
    }

    const needed = await getJobsNeedingDownload(jobs, SETTINGS.downloadWorkers);
    await runDownloadQueue(needed, "[natives]", SETTINGS.downloadWorkers);

    for (const { dest } of jobs) {
        try {
            const zip = new AdmZip(dest);
            zip.extractAllTo(nativesDir, true);
        } catch (err) {
            throw new Error(`[natives] Failed to extract ${dest}: ${err.message}`);
        }
    }

    console.log("[✓] Natives extracted.");
}

function getRemoteFileSize(url) {
    return new Promise(resolve => {
        https.get(url, { method: "HEAD" }, res => {
            const len = parseInt(res.headers["content-length"] || "0", 10);
            resolve(len);
        }).on("error", () => resolve(0));
    });
}

// ---------- Assets (global) ----------
async function downloadAssets(metadata) {
    const assetIndexInfo = metadata.assetIndex;
    if (!assetIndexInfo?.url || !assetIndexInfo.id) {
        console.log("[assets] No asset index info found.");
        return;
    }

    console.log(`\n[+] Fetching asset index: ${assetIndexInfo.id}`);

    let assetIndex;
    try {
        const response = await fetch(assetIndexInfo.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const indexBytes = Buffer.from(await response.arrayBuffer());
        const indexHash = createHash("sha1").update(indexBytes).digest("hex");
        if (assetIndexInfo.sha1 && indexHash.toLowerCase() !== assetIndexInfo.sha1.toLowerCase()) {
            throw new Error("Asset index failed SHA-1 validation.");
        }
        if (Number.isFinite(assetIndexInfo.size) && indexBytes.length !== assetIndexInfo.size) {
            throw new Error("Asset index failed size validation.");
        }
        assetIndex = JSON.parse(indexBytes.toString("utf8"));
    } catch (err) {
        throw new Error(`[assets] Failed to fetch or validate asset index: ${err.message}`);
    }

    const indexPath = path.join(ASSET_INDEXES_DIR, `${assetIndexInfo.id}.json`);
    try {
        await fs.promises.writeFile(indexPath, JSON.stringify(assetIndex, null, 2), "utf8");
        console.log(`[assets] Saved asset index to ${indexPath}`);
    } catch (err) {
        throw new Error(`[assets] Failed to save asset index: ${err.message}`);
    }
    console.log("[assets] Ready to download asset objects...");
    const objects = assetIndex.objects || {};
    const entries = Object.entries(objects);

    const jobs = [];
    for (const [, obj] of entries) {
        const hash = obj.hash;
        if (!/^[a-f0-9]{40}$/i.test(hash || "")) {
            throw new Error(`[assets] Invalid SHA-1 in asset index for '${hash}'.`);
        }
        const subdir = hash.slice(0, 2);
        const dest = path.join(ASSET_OBJECTS_DIR, subdir, hash);

        const url = `https://resources.download.minecraft.net/${subdir}/${hash}`;
        jobs.push({ url, dest, expected: { sha1: hash, size: obj.size } });
    }

    const needed = await getJobsNeedingDownload(jobs, SETTINGS.downloadWorkers);
    await runDownloadQueue(needed, "[assets]", SETTINGS.downloadWorkers);
}

// ---------- Searchable version picker ----------
async function pickVersionFromManifest(manifest) {
    const all = manifest.versions || [];
    if (all.length === 0) {
        console.log("No versions found in manifest.");
        return null;
    }

    const search = await ask("Filter versions (e.g. 1.20, leave blank for all): ");

    let filtered;

    if (!search.trim()) {
        // No search → show everything
        filtered = all;
    } else {
        const fuse = new Fuse(all, {
            keys: ["id", "type"],
            threshold: 0.4,        // lower = stricter, higher = fuzzier
            ignoreLocation: true,  // allows matching anywhere in the string
            includeScore: true
        });

        filtered = fuse.search(search).map(r => r.item);
    }

    if (filtered.length === 0) {
        console.log("No versions match that filter.");
        return null;
    }

    console.log("\nMatching versions:");
    filtered.forEach((v, i) => {
        console.log(`${i + 1}. ${v.id} (${v.type})`);
    });
    console.log("");

    const idxStr = await ask("Select a version by number: ");
    const idx = parseInt(idxStr, 10) - 1;

    if (isNaN(idx) || idx < 0 || idx >= filtered.length) {
        console.log("Invalid selection.");
        return null;
    }

    return filtered[idx].id;
}


// ---------- Version download (per version dir) ----------
async function downloadVersion(versionId, manifest) {
    const entry = manifest.versions.find(v => v.id === versionId);
    if (!entry) {
        console.error("Version not found in manifest:", versionId);
        return null;
    }

    console.log(`\n[+] Fetching metadata for ${versionId}`);

    let metadata;
    try {
        metadata = await fetchJSON(entry.url);
    } catch (err) {
        console.error(`[meta] Failed to fetch version metadata: ${err.message}`);
        return null;
    }

    const versionDir = path.join(VERSIONS_DIR, versionId);
    await fs.promises.mkdir(versionDir, { recursive: true });

    const clientUrl = metadata.downloads?.client?.url;
    if (!clientUrl) {
        console.error("[meta] No client download URL found for this version, this should not happen. Aborting.");
        return null;
    }

    try {
        await downloadLibraries(metadata, versionId);
        await downloadAndExtractNatives(metadata, versionId);
        await downloadAssets(metadata);
    } catch (err) {
        console.error(`[download] Failed to prepare verified game files: ${err.message}`);
        return null;
    }

    const clientPath = path.join(versionDir, "client.jar");
    const clientExpected = {
        sha1: metadata.downloads.client.sha1,
        size: metadata.downloads.client.size
    };
    if (await isFileValid(clientPath, clientExpected)) {
        console.log(`[client] Already exists and passed integrity validation: ${clientPath}`);
    } else {
        if (fs.existsSync(clientPath)) {
            console.log("[client] Existing client.jar is damaged; replacing it.");
            await fs.promises.unlink(clientPath);
        }
        console.log(`[client] Downloading client.jar to ${clientPath}`);
        try {
            await downloadFileWithProgress(clientUrl, clientPath, "[client]");
            if (!await isFileValid(clientPath, clientExpected)) {
                await fs.promises.unlink(clientPath).catch(() => {});
                throw new Error("Downloaded client.jar failed integrity validation.");
            }
            console.log("[client] Done.");
        } catch (err) {
            await fs.promises.unlink(clientPath).catch(() => {});
            console.error(`[client] Failed to download client.jar: ${err.message}`);
            return null;
        }
    }

    console.log(`\n[✓] Version ${versionId} has been downloaded and is ready to launch! :)`);
    return metadata;
}

function handleMinecraftOutput(line) {
    process.stdout.write(`\x1b[32m[MC OUT]\x1b[0m ${line}`);
	if (line.includes("Crash report saved")) {
        process.stdout.write("[!] Minecraft crashed!!");
		process.stdout.write("\n");
    }
}

function handleMinecraftError(line) {
    process.stdout.write(`\x1b[31m[MC ERR]\x1b[0m ${line}`);
	if (line.includes("Crash report saved")) {
        process.stdout.write("[!] Minecraft crashed!!");
		process.stdout.write("\n");
    }
}



// ---------- Launch ----------
async function launchMinecraft(versionId, metadata, auth) {
    console.log("\n[+] Preparing launch command...");

    const versionDir = path.join(VERSIONS_DIR, versionId);
    const versionLibDir = path.join(versionDir, "libraries");
    const nativesDir = path.join(versionDir, "natives");

    try {
        await downloadLibraries(metadata, versionId);
        await downloadAndExtractNatives(metadata, versionId);
        await downloadAssets(metadata);

        const clientPath = path.join(versionDir, "client.jar");
        const client = metadata.downloads?.client;
        if (!client?.url) throw new Error("Version metadata has no client JAR URL.");
        if (!await isFileValid(clientPath, { sha1: client.sha1, size: client.size })) {
            await fs.promises.mkdir(versionDir, { recursive: true });
            await fs.promises.unlink(clientPath).catch(err => {
                if (err.code !== "ENOENT") throw err;
            });
            console.log("[launch] Client JAR is missing or damaged; downloading a verified copy.");
            try {
                await downloadFileWithProgress(client.url, clientPath, "[client]");
                if (!await isFileValid(clientPath, { sha1: client.sha1, size: client.size })) {
                    throw new Error("Downloaded client JAR failed integrity validation.");
                }
            } catch (err) {
                await fs.promises.unlink(clientPath).catch(() => {});
                throw err;
            }
        }
    } catch (err) {
        console.error(`[launch] Asset/JAR integrity check or repair failed: ${err.message}`);
        return;
    }

    const libs = (metadata.libraries || [])
        .map(lib => {
            const artifact = lib.downloads?.artifact;
            if (!artifact?.url) return null;
            const relPath = getLibraryPath(lib, artifact);
            return path.join(versionLibDir, relPath);
        })
        .filter(Boolean);

    const clientJar = path.join(versionDir, "client.jar");
    const classpath = [...libs, clientJar].join(process.platform === "win32" ? ";" : ":");

    const java = await ensureJavaRuntime(versionId, metadata);
    if (!java) {
        console.error("[launch] Could not obtain Java runtime. Aborting launch.");
        return;
    }

    const mainClass = metadata.mainClass || "net.minecraft.client.main.Main";

    const args = [
        `-Djava.library.path=${nativesDir}`,
        "-Xmx2G",
        "-cp", classpath,
        mainClass,
        "--username", auth.profile.name,
        "--uuid", auth.profile.id,
        "--accessToken", auth.token,
        "--version", versionId,
        "--gameDir", path.join(BASE_DIR, versionId),
        "--assetsDir", ASSETS_DIR,
        "--assetIndex", metadata.assetIndex?.id || versionId
    ];

    console.log("[+] Launching Minecraft...");

    // ⭐ Wrap the process in a Promise so we can await it
    return new Promise((resolve) => {
        try {
            const mc = spawn(java, args);

            mc.stdout.on("data", data => {
                handleMinecraftOutput(data.toString());
            });

            mc.stderr.on("data", data => {
                handleMinecraftError(data.toString());
            });

            mc.on("error", err => {
                console.error(`[launch] Failed to start Java process: ${err.message}`);
            });

            mc.on("close", code => {
                if (code !== 0) {
                    console.log(`Minecraft exited with code ${code}! The game has probably crashed.`);
                } else {
                    console.log(`Minecraft exited normally. (code 0)`);
                }

                resolve(code); // ⭐ This makes the function wait until MC closes
            });
        } catch (err) {
            console.error(`[launch] Unexpected error while launching: ${err.message}`);
            resolve(-1);
        }
    });
}

// ---------- Installed versions ----------
function listInstalledVersions() {
    if (!fs.existsSync(VERSIONS_DIR)) return [];
    return fs.readdirSync(VERSIONS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
}

// ---------- Uninstall version menu ----------
async function uninstallVersionMenu() {
    const installed = listInstalledVersions();
    if (installed.length === 0) {
        console.log("No versions installed to uninstall.");
        return;
    }

    console.log("\nInstalled versions:");
    installed.forEach((v, i) => console.log(`${i + 1}. ${v}`));
    console.log("");

    const idxStr = await ask("Select a version to uninstall by number: ");
    const idx = parseInt(idxStr, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= installed.length) {
        console.log("Invalid selection.");
        return;
    }

    const versionId = installed[idx];
    const confirm = (await ask(`Are you sure you want to uninstall ${versionId}? This will delete its files. (y/N): `)).toLowerCase();
    if (confirm !== "y" && confirm !== "yes") {
        console.log("Uninstall cancelled.");
        return;
    }

    const versionDir = path.join(VERSIONS_DIR, versionId);
    try {
        await fs.promises.rm(versionDir, { recursive: true, force: true });
        removePerInstanceJava(versionId);
        console.log(`Version ${versionId} has been uninstalled.`);
    } catch (err) {
        console.error(`Failed to uninstall version ${versionId}: ${err.message}`);
    }
}

// ---------- Settings menu ----------
async function settingsMenu() {
    while (true) {
        console.log("\n=== SETTINGS ===");
        console.log(`1. Set download workers (current: ${SETTINGS.downloadWorkers})`);
        console.log("2. Manage per-instance Java paths");
        console.log("3. Back\n");

        const choice = await ask("Select an option: ");

        if (choice === "1") {
            const wStr = await ask("Enter number of download workers (1-32): ");
            const w = parseInt(wStr, 10);
            if (!isNaN(w) && w >= 1 && w <= 32) {
                SETTINGS.downloadWorkers = w;
                saveSettings(SETTINGS);
                console.log(`Download workers set to ${w}.`);
            } else {
                console.log("Invalid number.");
            }
        } else if (choice === "2") {
            await perInstanceJavaMenu();
        } else if (choice === "3") {
            return;
        } else {
            console.log("Invalid choice.");
        }
    }
}

async function perInstanceJavaMenu() {
    while (true) {
        console.log("\n=== PER-INSTANCE JAVA ===");
        if (SETTINGS.perInstanceJava.length === 0) {
            console.log("No per-instance Java paths configured.");
        } else {
            SETTINGS.perInstanceJava.forEach((e, i) => {
                console.log(
                    `${i + 1}. ${e.version} -> ${e.path} (addedAt: ${new Date(
                        e.addedAt * 1000
                    ).toISOString()})`
                );
            });
        }
        console.log("\nA. Add / update entry");
        console.log("R. Remove entry");
        console.log("B. Back\n");

        const choice = (await ask("Select an option: ")).toUpperCase();

        if (choice === "A") {
            const versionId = await ask("Version ID (e.g. 1.20.4): ");
            if (!versionId) {
                console.log("No version ID entered.");
                continue;
            }
            const p = await ask("Enter full path to Java executable: ");
            if (!p) {
                console.log("No path entered.");
                continue;
            }
            if (await validateJavaPath(p)) {
                setPerInstanceJava(versionId, p);
                console.log("Per-instance Java entry saved.");
            } else {
                console.log("That Java path did not work.");
            }
        } else if (choice === "R") {
            const versionId = await ask("Version ID to remove: ");
            if (!versionId) {
                console.log("No version ID entered.");
                continue;
            }
            removePerInstanceJava(versionId);
            console.log("Per-instance Java entry removed (if it existed).");
        } else if (choice === "B") {
            return;
        } else {
            console.log("Invalid choice.");
        }
    }
}

// ---------- Auth ----------
async function loadAuth() {
	console.log("[auth] Logging in....");
    const flow = new Authflow(
        "CALLAUNCHER",
        AUTH_CACHE_PATH
    );

    let auth;
    try {
        auth = await flow.getMinecraftJavaToken({
            fetchProfile: true,
            fetchEntitlements: true
        });
    } catch (err) {
        console.log("[auth] Failed to get Minecraft Java token:", err.message);
        throw err;
    }

    // Explicit entitlement check
    const ownsJava = auth.entitlements?.items?.some(
        e => e.name === "product_minecraft"
    );
	console.log("[auth] Checking entitlements....");
    if (!ownsJava) {
        console.log("[auth] This account does NOT own a copy of Minecraft Java Edition.");
        throw new Error("Minecraft Java entitlement missing.");
    }
	else {
		console.log("[auth] You own a copy of minecraft!");
	}

    return auth;
}


// ---------- Manifest fetch ----------
async function loadMojangManifest() {
    console.log("[meta] Fetching Mojang version manifest...");
    return await fetchJSON(MOJANG_MANIFEST_URL);
}

function formatToken(str, options = {}) {
    if (typeof str !== "string") return "";

    const {
        visibleStart = 6,   // how many chars to show at the start
        visibleEnd = 0,     // how many chars to show at the end
        maskChar = "?",     // masking character
        maxLength = null    // optional truncation limit
    } = options;

    // Optional truncation
    let s = str;
    if (maxLength && str.length > maxLength) {
        s = str.slice(0, maxLength);
    }

    // If string is too short to mask, return as-is
    if (s.length <= visibleStart + visibleEnd) return s;

    const start = s.slice(0, visibleStart);
    const end = visibleEnd > 0 ? s.slice(s.length - visibleEnd) : "";
    const masked = maskChar.repeat(s.length - visibleStart - visibleEnd);

    return start + masked + end;
}

// ---------- Main menu ----------
async function mainMenu() {
    BoxMsg("CALLUM LAUNCHER - UNOFFICAL MINECRAFT JAVA EDITION LAUNCHER");

    const auth = await loadAuth();
    console.log(
    `[auth] Logged in as ${auth.profile.name} (${auth.profile.id}) (tok: ${formatToken(auth.token, 
		{ visibleStart: 6, 
			visibleEnd: 4, 
			maxLength: 20
		})})`
	);


    let manifest;
    try {
        manifest = await loadMojangManifest();
    } catch (err) {
        console.error("[meta] Failed to load Mojang manifest:", err.message);
        return;
    }

    while (true) {
        console.log("\n=== MAIN MENU ===");
        console.log("1. Download a version");
        console.log("2. Launch installed version");
        console.log("3. Uninstall version");
        console.log("4. Settings");
        console.log("5. Exit\n");

        const choice = await ask("Select an option: ");

        if (choice === "1") {
            const versionId = await pickVersionFromManifest(manifest);
            if (!versionId) continue;

            const metadata = await downloadVersion(versionId, manifest);
            if (!metadata) continue;
        } else if (choice === "2") {
            const installed = listInstalledVersions();
            if (installed.length === 0) {
                console.log("No installed versions.");
                continue;
            }

            console.log("\nInstalled versions:");
            installed.forEach((v, i) => console.log(`${i + 1}. ${v}`));
            console.log("");

            const idxStr = await ask("Select a version to launch by number: ");
            const idx = parseInt(idxStr, 10) - 1;
            if (isNaN(idx) || idx < 0 || idx >= installed.length) {
                console.log("Invalid selection.");
                continue;
            }

            const versionId = installed[idx];
            const entry = manifest.versions.find(v => v.id === versionId);
            if (!entry) {
                console.log("Version not found in manifest; cannot fetch metadata.");
                continue;
            }

            let metadata;
            try {
                metadata = await fetchJSON(entry.url);
            } catch (err) {
                console.error("[meta] Failed to fetch version metadata:", err.message);
                continue;
            }

            await launchMinecraft(versionId, metadata, auth);
        } else if (choice === "3") {
            await uninstallVersionMenu();
        } else if (choice === "4") {
            await settingsMenu();
        } else if (choice === "5") {
            console.log("Goodbye.");
            process.exit(0);
        } else {
            console.log("Invalid choice.");
        }
    }
}

// ---------- Entry point ----------
(async () => {
    try {
        await mainMenu();
    } catch (err) {
        console.error("Unexpected error! ", err);
    }
})();
