import keytar from "keytar";

const SERVICE = "CALLAUNCHER";

export async function saveAuthCache(username, jsonString) {
    console.log("Saving auth cache for", username);
    await keytar.setPassword(SERVICE, username, jsonString);
}

export async function loadAuthCache(username) {
    console.log("Loading auth cache for", username);
    return await keytar.getPassword(SERVICE, username);
}

export async function deleteAuthCache(username) {
    console.log("Deleting auth cache for", username);
    await keytar.deletePassword(SERVICE, username);
}
