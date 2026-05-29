// CALLAUNCHER — per-instance Java only, Mojang runtimes when available, settings.json (C-style), download workers, no Blessed
import { saveAuthCache, loadAuthCache } from "./secureStore.js";
import { Authflow } from "prismarine-auth";
import cliProgress from "cli-progress";
import os from "os";
import path from "path";
import fs from "fs";
import https from "https";
import readline from "readline";
import { spawn } from "child_process";
import AdmZip from "adm-zip";

// ---------- Zulu Java Downloader (per-version) ----------
// ---------- Zulu Java Downloader (Metadata API, per-version) ----------
const ZULU_META = "https://api.azul.com/metadata/v1/zulu/packages/";

function detectZuluPlatform() {
    const platform = process.platform;
    const arch = process.arch;

    let os, cpu;

    if (platform === "win32") os = "windows";
    else if (platform === "linux") os = "linux";
    else if (platform === "darwin") os = "macos";
    else os = "linux";

    if (arch === "x64" || arch === "amd64") cpu = "x86_64";
    else if (arch === "arm64") cpu = "aarch64";
    else cpu = "x86_64";

    return { os, cpu };
}

async function queryZuluMetadata(major) {
    const { os, cpu } = detectZuluPlatform();

    const params = new URLSearchParams({
        java_version: String(major),
        os,
        arch: cpu,
        java_package_type: "jdk",     // JRE deprecated
        release_status: "ga",         // stable builds
        availability_types: "CA",     // free community builds
        page: "1",
        page_size: "100"
    });

    const url = `${ZULU_META}?${params.toString()}`;
    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`Zulu Metadata API HTTP ${res.status}`);
    }

    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) {
        return null;
    }

    // Filter only entries with a real download_url
    const valid = list.filter(e => e.download_url);
    if (valid.length === 0) return null;

    // Pick the newest build (latest=true preferred)
    const latest = valid.find(e => e.latest) || valid[valid.length - 1];

    return latest;
}

// Move this OUTSIDE the function so it can be reused
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

async function downloadZuluJava(versionId, requiredMajor) {
    const versionDir = path.join(VERSIONS_DIR, versionId);
    const runtimeDir = path.join(versionDir, "java-zulu");

    // ⭐ NEW: Check for ANY existing Java binary inside java-zulu/
    const existing = findJavaBin(runtimeDir);
    if (existing) {
        console.log("[java] Existing Zulu runtime found.");
        return existing;
    }

    console.log(`[java] Querying Azul Metadata API for Java ${requiredMajor}...`);

    let pkg;
    try {
        pkg = await queryZuluMetadata(requiredMajor);
    } catch (err) {
        console.error("[java] Failed to query Zulu Metadata API:", err.message);
        return null;
    }

    if (!pkg) {
        console.error("[java] No suitable Zulu package found.");
        return null;
    }

    const url = pkg.download_url;
    if (!url) {
        console.error("[java] Package has no download_url (unexpected).");
        return null;
    }

    console.log(`[java] Downloading: ${pkg.name}`);

    const tmpZip = path.join(versionDir, `zulu-${requiredMajor}.zip`);

    try {
        await downloadFile(url, tmpZip);
    } catch (err) {
        console.error("[java] Failed to download Zulu ZIP:", err.message);
        return null;
    }

    // Extract ZIP
    try {
        await fs.promises.mkdir(runtimeDir, { recursive: true });
        const zip = new AdmZip(tmpZip);
        zip.extractAllTo(runtimeDir, true);
    } catch (err) {
        console.error("[java] Failed to extract Zulu ZIP:", err.message);
        return null;
    } finally {
        fs.unlink(tmpZip, () => {});
    }

    // Find java binary again after extraction
    const found = findJavaBin(runtimeDir);
    if (!found) {
        console.error("[java] Could not locate java binary in extracted Zulu runtime.");
        return null;
    }

    console.log("[java] Zulu Java downloaded! PATH:", found);
    return found;
}



// ---------- Base paths ----------
const BASE_DIR = path.join(os.homedir(), "CALLUM_LAUNCH");
const VERSIONS_DIR = path.join(BASE_DIR, "versions");
const ASSETS_DIR = path.join(BASE_DIR, "assets");
const ASSET_OBJECTS_DIR = path.join(ASSETS_DIR, "objects");
const ASSET_INDEXES_DIR = path.join(ASSETS_DIR, "indexes");
const SETTINGS_PATH = path.join(BASE_DIR, "settings.json");

for (const dir of [BASE_DIR, VERSIONS_DIR, ASSETS_DIR, ASSET_OBJECTS_DIR, ASSET_INDEXES_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
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

// ---------- Download workers ----------
async function runDownloadQueue(jobs, name, workers) {
    if (jobs.length === 0) {
        console.log(`${name} All items already present.`);
        return;
    }

    const bar = new cliProgress.SingleBar(
        {
            clearOnComplete: true,
            hideCursor: true,
            format: `${name} {bar} {percentage}% | {value}/{total}`
        },
        cliProgress.Presets.shades_classic
    );
    bar.start(jobs.length, 0);

    let index = 0;
    let completed = 0;

    async function worker() {
        while (true) {
            let job;
            if (index >= jobs.length) break;
            job = jobs[index++];
            try {
                await downloadFile(job.url, job.dest);
            } catch (err) {
                console.error(`\n${name} Failed: ${job.url} -> ${err.message}`);
            }
            completed++;
            bar.update(completed);
        }
    }

    const count = Math.max(1, Math.min(workers, jobs.length));
    const promises = [];
    for (let i = 0; i < count; i++) {
        promises.push(worker());
    }
    await Promise.all(promises);
    bar.stop();
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

// ---------- OS → Mojang platform ----------
function detectRuntimePlatform() {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === "win32") return "windows-x64";
    if (platform === "linux") return "linux";
    if (platform === "darwin") {
        if (arch === "arm64") return "mac-os-arm64";
        return "mac-os";
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
                resolve(true); // even non-zero is usually fine for -version
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

// ---------- Mojang Java runtime download (per-version, from metadata.javaVersion.component) ----------
// DEPRECATED, DO NOT USE OR MODIFY: Mojang runtimes are no longer commonly used and their API is dead. We use azul's Zulu API instead.
async function tryDownloadMojangJava(versionId, metadata) {
    const versionDir = path.join(VERSIONS_DIR, versionId);
    const runtimeDir = path.join(versionDir, "java");

    const javaBin =
        process.platform === "win32"
            ? path.join(runtimeDir, "bin", "java.exe")
            : path.join(runtimeDir, "bin", "java");

    if (fs.existsSync(javaBin)) {
        return javaBin;
    }

    const component = metadata.javaVersion?.component;
    if (!component) {
        console.log("[java] No javaVersion.component in metadata.");
        return null;
    }

    console.log(`\n[+] Trying Mojang Java runtime for ${versionId}: ${component}`);

    // Step 1: fetch master manifest
    let master;
    try {
        master = await fetchJSON(
            "https://piston-meta.mojang.com/v1/products/java-runtime/manifest.json"
        );
    } catch (err) {
        console.error("[java] Failed to fetch master runtime manifest:", err.message);
        return null;
    }

    // Step 2: find component entry
    const compEntry = master.find(e => e.name === component);
    if (!compEntry) {
        console.error(`[java] Component '${component}' not found in master manifest.`);
        return null;
    }

    // Step 3: find platform entry
    const platform = detectRuntimePlatform();
    const platEntry = compEntry.platforms?.[platform];
    if (!platEntry) {
        console.error(`[java] Component '${component}' has no platform '${platform}'.`);
        return null;
    }

    // Step 4: fetch platform manifest
    let runtimeManifest;
    try {
        runtimeManifest = await fetchJSON(platEntry.manifest.url);
    } catch (err) {
        console.error(`[java] Failed to fetch runtime manifest: ${err.message}`);
        return null;
    }

    // Step 5: download files
    const files = runtimeManifest.files || {};
    const jobs = [];

    for (const [relPath, info] of Object.entries(files)) {
        if (!info?.downloads?.raw?.url) continue;
        const dest = path.join(runtimeDir, relPath);
        jobs.push({ url: info.downloads.raw.url, dest, executable: !!info.executable });
    }

    await runDownloadQueue(jobs, "[java]", SETTINGS.downloadWorkers);

    // Step 6: fix permissions
    if (process.platform !== "win32") {
        for (const job of jobs) {
            if (job.executable) {
                try { await fs.promises.chmod(job.dest, 0o755); } catch {}
            }
        }
    }

    if (!fs.existsSync(javaBin)) {
        console.error("[java] Java binary missing after download.");
        return null;
    }

    return javaBin;
}


// ---------- Java selection logic (PER INSTANCE ONLY) ----------
function requiredJavaMajorFor(versionId, metadata) {
    // If Mojang metadata includes a majorVersion, trust it
    if (metadata?.javaVersion?.majorVersion) {
        return metadata.javaVersion.majorVersion;
    }

    // Fallback rules (rarely needed)
    if (isAtLeast(versionId, "1.20.5")) return 21;
    if (isAtLeast(versionId, "1.17")) return 17;
    return 8;
}

async function ensureJavaRuntime(versionId, metadata) {
    // 1) Per-instance Java from settings
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

    // 2) Zulu Java (per-version)
    const major = requiredJavaMajorFor(versionId, metadata);
    const zulu = await downloadZuluJava(versionId, major);
    if (zulu && await validateJavaPath(zulu)) {
        console.log(`[java] Using downloaded Zulu Java ${major} for ${versionId}.`);
        return zulu;
    }

    // 3) Ask user as last resort
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

        if (!fs.existsSync(dest)) {
            jobs.push({ url: artifact.url, dest });
        }
    }

    await runDownloadQueue(jobs, "[libs]", SETTINGS.downloadWorkers);
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
        console.log("[natives] No legacy native libraries found for this version (modern versions bundle natives in jars).");
        return;
    }

    console.log(`\n[+] Native JARs to download & extract: ${nativeEntries.length}`);

    const jobs = [];
    for (const { info } of nativeEntries) {
        const jarName = path.basename(info.path || "natives.jar");
        const jarPath = path.join(tempDir, jarName);
        jobs.push({ url: info.url, dest: jarPath });
    }

    await runDownloadQueue(jobs, "[natives]", SETTINGS.downloadWorkers);

    for (const { dest } of jobs) {
        try {
            const zip = new AdmZip(dest);
            zip.extractAllTo(nativesDir, true);
        } catch (err) {
            console.error(`[natives] Failed to extract ${dest}: ${err.message}`);
        }
    }

    console.log("[✓] Natives extracted.");
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
        assetIndex = await fetchJSON(assetIndexInfo.url);
    } catch (err) {
        console.error(`[assets] Failed to fetch asset index: ${err.message}`);
        return;
    }

    const indexPath = path.join(ASSET_INDEXES_DIR, `${assetIndexInfo.id}.json`);
    try {
        await fs.promises.writeFile(indexPath, JSON.stringify(assetIndex, null, 2), "utf8");
        console.log(`[assets] Saved asset index to ${indexPath}`);
    } catch (err) {
        console.error(`[assets] Failed to save asset index: ${err.message}`);
    }
    console.log("[assets] Ready to download asset objects...");
    const objects = assetIndex.objects || {};
    const entries = Object.entries(objects);

    const jobs = [];
    for (const [, obj] of entries) {

        const hash = obj.hash;
        const subdir = hash.slice(0, 2);
        const dest = path.join(ASSET_OBJECTS_DIR, subdir, hash);

        if (!fs.existsSync(dest)) {
            const url = `https://resources.download.minecraft.net/${subdir}/${hash}`;
            jobs.push({ url, dest });
        }
    }

    await runDownloadQueue(jobs, "[assets]", SETTINGS.downloadWorkers);
}

// ---------- Searchable version picker (1.17.1+) ----------
async function pickVersionFromManifest(manifest) {
    const all = manifest.versions.filter(v => isAtLeast(v.id, "1.17.1"));
    if (all.length === 0) {
        console.log("No versions >= 1.17.1 found in manifest.");
        return null;
    }

    const search = await ask("Filter versions (e.g. 1.20, leave blank for all): ");
    const filtered = all.filter(v => v.id.includes(search));

    if (filtered.length === 0) {
        console.log("No versions match that filter.");
        return null;
    }

    const toShow = filtered.slice(0, 40);
    console.log("\nMatching versions:");
    toShow.forEach((v, i) => {
        console.log(`${i + 1}. ${v.id} (${v.type})`);
    });
    console.log("");

    const idxStr = await ask("Select a version by number: ");
    const idx = parseInt(idxStr, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= toShow.length) {
        console.log("Invalid selection.");
        return null;
    }

    return toShow[idx].id;
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

    await downloadLibraries(metadata, versionId);
    await downloadAndExtractNatives(metadata, versionId);
    await downloadAssets(metadata);

    const clientPath = path.join(versionDir, "client.jar");
    if (fs.existsSync(clientPath)) {
        console.log(`[client] Already exists: ${clientPath}`);
    } else {
        console.log(`[client] Downloading client.jar to ${clientPath}`);
        try {
            await downloadFile(clientUrl, clientPath);
            console.log("[client] Done.");
        } catch (err) {
            console.error(`[client] Failed to download client.jar: ${err.message}`);
            return null;
        }
    }

    console.log(`\n[✓] Version ${versionId} has been downloaded and is ready to launch! :)`);
    return metadata;
}

// ---------- Launch ----------
async function launchMinecraft(versionId, metadata, auth) {
    console.log("\n[+] Preparing launch command...");

    const versionDir = path.join(VERSIONS_DIR, versionId);
    const versionLibDir = path.join(versionDir, "libraries");
    const nativesDir = path.join(versionDir, "natives");

    const libs = (metadata.libraries || [])
        .map(lib => {
            const artifact = lib.downloads?.artifact;
            if (!artifact?.url) return null;
            const relPath = getLibraryPath(lib, artifact);
            return path.join(versionLibDir, relPath);
        })
        .filter(Boolean);

    const clientJar = path.join(versionDir, "client.jar");
    if (!fs.existsSync(clientJar)) {
        console.error("[launch] BUG!!!!! Client JAR missing at expected path:", clientJar);
        return;
    }

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
    console.log("[launch] Java command:", java);
    console.log("[launch] libraries:");
    libs.forEach(lib => console.log("  -", lib));
    console.log("[+] Launching Minecraft...");
    try {
        const mc = spawn(java, args, { stdio: "inherit" });

        mc.on("error", err => {
            console.error(`[launch] Failed to start Java process: ${err.message}`);
        });

        mc.on("close", code => {
            console.log(`Minecraft exited with code ${code}`);
        });
    } catch (err) {
        console.error(`[launch] Unexpected error while launching: ${err.message}`);
    }
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
            const wStr = await ask("Enter number of download workers (1-16): ");
            const w = parseInt(wStr, 10);
            if (!isNaN(w) && w >= 1 && w <= 16) {
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
                console.log("Per-instance Java saved.");
            } else {
                console.log("That Java path did not work. Not saved.");
            }
        } else if (choice === "R") {
            const versionId = await ask("Version ID to remove: ");
            if (!versionId) {
                console.log("No version ID entered.");
                continue;
            }
            removePerInstanceJava(versionId);
            console.log("Entry removed (if it existed).");
        } else if (choice === "B") {
            return;
        } else {
            console.log("Invalid choice.");
        }
    }
}

// ---------- Main auth ----------
let result;
async function authenticateAndCheckOwnership() {
    let result;

    try {
        console.log("[+] Authenticating with Microsoft...");

        // Load cached token from secure storage
        const cached = await loadAuthCache("default");

        const flow = new Authflow("callauncher", "./auth-cache");

        // IMPORTANT: ensure cache object exists BEFORE login
        flow.cache = cached ? JSON.parse(cached) : {};

        result = await flow.getMinecraftJavaToken({
            fetchProfile: true,
            fetchEntitlements: true
        });

        console.log("Username:", result.profile.name);
        console.log("Authentication successful!");

        // Save the FULL cache (including flow + msalConfig)
        await saveAuthCache("default", JSON.stringify(flow.cache));

    } catch (err) {
        console.error("------ IMPORTANT ------");
        console.error("Authentication failed.");
        console.error("If you're running this over SSH, the Linux keyring is locked and cannot store credentials.");
        console.error("Please run the launcher from the Raspberry Pi desktop session instead.");
        console.error(`Details: ${err.message}`);
        process.exit(1);
    }


    // Ownership check
    const ownsMinecraft = result.entitlements?.items?.some(
        e => e.name === "game_minecraft"
    );

    if (!ownsMinecraft) {
        console.error("----- YOU DO NOT OWN MINECRAFT -----");
        console.error("In order to use this launcher, you must own Minecraft Java Edition on your Microsoft account.");
        console.error("If you believe this is a mistake, please contact support with your account details.");
        console.error("If you were attempting to use a cracked or pirated account, please purchase the game to use this launcher.");
        console.error("-----------------------------------");
        process.exit(1);
    }

    return result;
}

result = await authenticateAndCheckOwnership();
// ---------- Main menu loop ----------
while (true) {
    console.log("\n=== CALLAUNCHER MENU ===");
    console.log("1. Install a version");
    console.log("2. Launch installed version");
    console.log("3. Uninstall a version");
    console.log("4. Settings");
    console.log("5. Exit\n");

    const choice = await ask("Select an option: ");

    if (choice === "1") {
        let manifest;
        try {
            manifest = await fetchJSON(
                "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
            );
        } catch (err) {
            console.error(`[manifest] Failed to fetch version manifest: ${err.message}`);
            continue;
        }

        console.log("\nInstall options:");
        console.log("1. Latest release");
        console.log("2. Latest snapshot");
        console.log("3. Search & pick (>= 1.17.1)");
        console.log("4. Specific version ID\n");

        const installChoice = await ask("Select an option: ");

        let versionId = null;
        if (installChoice === "1") {
            versionId = manifest.latest.release;
            console.log("Latest release:", versionId);
        } else if (installChoice === "2") {
            versionId = manifest.latest.snapshot;
            console.log("Latest snapshot:", versionId);
        } else if (installChoice === "3") {
            versionId = await pickVersionFromManifest(manifest);
            if (!versionId) {
                console.log("No version selected.");
                continue;
            }
        } else if (installChoice === "4") {
            versionId = await ask("Enter version ID (e.g., 1.20.4): ");
        } else {
            console.log("Cancelled.");
            continue;
        }

        await downloadVersion(versionId, manifest);

    } else if (choice === "2") {
        const installed = listInstalledVersions();
        if (installed.length === 0) {
            console.log("No versions installed yet.");
            continue;
        }

        console.log("\nInstalled versions:");
        installed.forEach((v, i) => console.log(`${i + 1}. ${v}`));
        console.log("");

        const idxStr = await ask("Select a version by number: ");
        const idx = parseInt(idxStr, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= installed.length) {
            console.log("Invalid selection.");
            continue;
        }

        const versionId = installed[idx];

        let manifest;
        try {
            manifest = await fetchJSON(
                "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
            );
        } catch (err) {
            console.error(`[manifest] Failed to fetch version manifest: ${err.message}`);
            continue;
        }

        const entry = manifest.versions.find(v => v.id === versionId);
        if (!entry) {
            console.log("Version metadata not found in manifest.");
            continue;
        }

        let metadata;
        try {
            metadata = await fetchJSON(entry.url);
        } catch (err) {
            console.error(`[meta] Failed to fetch version metadata: ${err.message}`);
            continue;
        }

        await launchMinecraft(versionId, metadata, result);

    } else if (choice === "3") {
        await uninstallVersionMenu();
    } else if (choice === "4") {
        await settingsMenu();
    } else if (choice === "5") {
        console.log("Goodbye!");
        process.exit(0);
    } else {
        console.log("Invalid choice.");
    }
}
