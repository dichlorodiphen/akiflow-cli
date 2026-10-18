/// <reference types="bun" />

import { Database } from "bun:sqlite";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	spyOn,
} from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decryptChromeValue,
	deriveKey,
	type ExtractedToken,
	extractFromBrowser,
	extractFromChrome,
	extractFromIndexedDB,
	extractFromSafari,
	getKeychainPassword,
	scanBrowsers,
} from "../../lib/auth/extract-token";
import * as browserPaths from "../../lib/browser-paths";

// Browser auth tests must never inspect the host's browser profiles or Keychain.
let fixtureRoot: string;
const originalSpawn = Bun.spawn;
let spawnSpy: ReturnType<typeof spyOn>;
let pathsSpy: ReturnType<typeof spyOn>;
beforeAll(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), "af-browser-isolation-"));
	writeFileSync(
		join(fixtureRoot, "security"),
		"#!/bin/sh\nprintf '%s\\n' 'fixture-safe-storage'\n",
		{ mode: 0o700 },
	);
});
beforeEach(() => {
	spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
		command: unknown,
		options?: unknown,
	) => {
		if (!Array.isArray(command) || command[0] !== "security")
			throw new Error("Unexpected browser-test subprocess");
		return Reflect.apply(originalSpawn, Bun, [
			[join(fixtureRoot, "security"), ...command.slice(1)],
			options,
		]);
	}) as typeof Bun.spawn);
	pathsSpy = spyOn(browserPaths, "getAllBrowserPaths").mockReturnValue([
		{
			id: "chrome",
			name: "Fixture Chrome",
			cookiePath: join(fixtureRoot, "missing"),
			indexedDBPath: join(fixtureRoot, "IndexedDB"),
			encryptionMethod: "pbkdf2",
		},
		{
			id: "safari",
			name: "Fixture Safari",
			cookiePath: join(fixtureRoot, "missing-safari"),
			indexedDBPath: null,
			encryptionMethod: "binary",
		},
	]);
});
afterEach(() => {
	pathsSpy.mockRestore();
	spawnSpy.mockRestore();
});
afterAll(() => {
	rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("deriveKey", () => {
	it("derives 16-byte key from password using PBKDF2", async () => {
		// given
		const password = "testpassword";

		// when
		const key = await deriveKey(password);

		// then
		expect(key).toBeInstanceOf(Uint8Array);
		expect(key.length).toBe(16);
	});

	it("produces consistent key for same password", async () => {
		// given
		const password = "consistentpassword";

		// when
		const key1 = await deriveKey(password);
		const key2 = await deriveKey(password);

		// then
		expect(key1).toEqual(key2);
	});

	it("produces different keys for different passwords", async () => {
		// given
		const password1 = "password1";
		const password2 = "password2";

		// when
		const key1 = await deriveKey(password1);
		const key2 = await deriveKey(password2);

		// then
		expect(key1).not.toEqual(key2);
	});
});

describe("decryptChromeValue", () => {
	it("round-trips Chrome AES-CBC plaintext without removing padding twice", async () => {
		const key = await deriveKey("fixture-safe-storage");
		const cryptoKey = await crypto.subtle.importKey(
			"raw",
			Uint8Array.from(key),
			"AES-CBC",
			false,
			["encrypt"],
		);
		for (const plaintext of [
			"session-jwt-value",
			"value-ending-in-1",
			"value-ending-in-} ",
		]) {
			const encrypted = new Uint8Array(
				await crypto.subtle.encrypt(
					{ name: "AES-CBC", iv: new Uint8Array(16).fill(0x20) },
					cryptoKey,
					new TextEncoder().encode(plaintext),
				),
			);
			const chromeValue = new Uint8Array(3 + encrypted.length);
			chromeValue.set(new TextEncoder().encode("v10"));
			chromeValue.set(encrypted, 3);
			expect(await decryptChromeValue(chromeValue, key)).toBe(plaintext);
		}
	});

	it("returns null for corrupt ciphertext instead of aborting browser scans", async () => {
		expect(
			await decryptChromeValue(
				new TextEncoder().encode("v10broken"),
				await deriveKey("fixture"),
			),
		).toBeNull();
	});

	it("returns original string for non-encrypted values", async () => {
		// given
		const plainValue = new TextEncoder().encode("plaintext");
		const key = await deriveKey("anypassword");

		// when
		const result = await decryptChromeValue(plainValue, key);

		// then
		expect(result).toBe("plaintext");
	});

	it("returns null for empty encrypted value", async () => {
		// given
		const emptyValue = new Uint8Array([]);
		const key = await deriveKey("anypassword");

		// when
		const result = await decryptChromeValue(emptyValue, key);

		// then
		expect(result).toBeNull();
	});

	it("returns null for too short encrypted value", async () => {
		// given
		const shortValue = new Uint8Array([118, 49]); // "v1" - only 2 bytes
		const key = await deriveKey("anypassword");

		// when
		const result = await decryptChromeValue(shortValue, key);

		// then
		expect(result).toBeNull();
	});
});

describe("getKeychainPassword", () => {
	it("returns null for unknown browser", async () => {
		// given
		const unknownBrowser = "firefox";

		// when
		const result = await getKeychainPassword(unknownBrowser);

		// then
		expect(result).toBeNull();
	});

	it("uses a fixture Keychain helper for chrome", async () => {
		// given
		const browser = "chrome";

		// when
		const result = await getKeychainPassword(browser);

		// then
		expect(result).toBe("fixture-safe-storage");
	});
});

describe("scanBrowsers", () => {
	it("returns array of ExtractedToken", async () => {
		// given/when
		const tokens = await scanBrowsers();

		// then
		expect(Array.isArray(tokens)).toBe(true);
		for (const token of tokens) {
			expect(token).toHaveProperty("browser");
			expect(token).toHaveProperty("token");
			expect(token).toHaveProperty("source");
		}
	});

	it("returns tokens with valid browser types", async () => {
		// given
		const validBrowsers = ["chrome", "arc", "brave", "edge", "safari"];

		// when
		const tokens = await scanBrowsers();

		// then
		for (const token of tokens) {
			expect(validBrowsers).toContain(token.browser);
		}
	});

	it("returns tokens with non-empty token values", async () => {
		// given/when
		const tokens = await scanBrowsers();

		// then
		for (const token of tokens) {
			expect(token.token.length).toBeGreaterThan(0);
		}
	});
});

describe("extractFromBrowser", () => {
	it("returns empty array for non-existent browser path", async () => {
		// given
		const browser = "brave"; // may not be installed

		// when
		const tokens = await extractFromBrowser(browser);

		// then
		expect(Array.isArray(tokens)).toBe(true);
	});

	it("returns array of tokens from chrome if installed", async () => {
		// given
		const browser = "chrome";

		// when
		const tokens = await extractFromBrowser(browser);

		// then
		expect(Array.isArray(tokens)).toBe(true);
		for (const token of tokens) {
			expect(token.browser).toBe("chrome");
		}
	});

	it("returns array of tokens from safari if installed", async () => {
		// given
		const browser = "safari";

		// when
		const tokens = await extractFromBrowser(browser);

		// then
		expect(Array.isArray(tokens)).toBe(true);
		for (const token of tokens) {
			expect(token.browser).toBe("safari");
		}
	});
});

describe("IndexedDB rotating files", () => {
	it("continues past vanished files to find other session tokens", async () => {
		const directory = mkdtempSync(join(tmpdir(), "af-indexeddb-fixture-"));
		try {
			const database = join(
				directory,
				"https_web.akiflow.com_0.indexeddb.leveldb",
			);
			mkdirSync(database);
			symlinkSync(join(directory, "missing"), join(database, "000001.ldb"));
			const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.fixtureSignature`;
			writeFileSync(join(database, "000002.log"), jwt);
			const result = await extractFromIndexedDB({
				id: "chrome",
				name: "Fixture",
				cookiePath: join(directory, "unused"),
				indexedDBPath: directory,
				encryptionMethod: "pbkdf2",
			});
			expect(result.map((value) => value.token)).toEqual([jwt]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("ExtractedToken interface", () => {
	it("has correct structure", () => {
		// given
		const token: ExtractedToken = {
			browser: "chrome",
			token: "test-jwt-token",
			source: "/path/to/cookies",
		};

		// when/then
		expect(token.browser).toBe("chrome");
		expect(token.token).toBe("test-jwt-token");
		expect(token.source).toBe("/path/to/cookies");
	});

	it("accepts all valid browser types", () => {
		// given
		const browsers = ["chrome", "arc", "brave", "edge", "safari"] as const;

		// when/then
		for (const browser of browsers) {
			const token: ExtractedToken = {
				browser,
				token: "token",
				source: "/source",
			};
			expect(token.browser).toBe(browser);
		}
	});
});

describe("Chrome SQLite mock", () => {
	let tempDir: string;
	let mockDbPath: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "extract-token-test-"));
		mockDbPath = join(tempDir, "Cookies");

		const db = new Database(mockDbPath);
		db.run(`
      CREATE TABLE cookies (
        host_key TEXT,
        name TEXT,
        value TEXT,
        encrypted_value BLOB
      )
    `);

		db.run(`
      INSERT INTO cookies (host_key, name, value, encrypted_value)
      VALUES ('.akiflow.com', 'remember_web_test', 'plain_token', NULL)
    `);

		db.close();
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("imports only Akiflow domain cookies and continues after corrupt encryption", async () => {
		const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.fixtureSignature`;
		const db = new Database(mockDbPath);
		db.run("INSERT INTO cookies VALUES (?, ?, ?, ?)", [
			".akiflow.com",
			"remember_web_broken",
			"",
			new TextEncoder().encode("v10broken"),
		]);
		db.run("INSERT INTO cookies VALUES (?, ?, ?, NULL)", [
			"evilakiflow.com",
			"remember_web_wrong",
			jwt,
		]);
		db.run("INSERT INTO cookies VALUES (?, ?, ?, NULL)", [
			".web.akiflow.com",
			"remember_web_valid",
			jwt,
		]);
		db.close();
		const result = await extractFromChrome({
			id: "chrome",
			name: "Fixture",
			cookiePath: mockDbPath,
			indexedDBPath: null,
			encryptionMethod: "pbkdf2",
		});
		expect(result.map((value) => value.token)).toEqual([jwt]);
		const cleanup = new Database(mockDbPath);
		cleanup.run("DELETE FROM cookies WHERE name != 'remember_web_test'");
		cleanup.close();
	});

	it("creates valid SQLite database with cookies table", () => {
		// given
		const db = new Database(mockDbPath, { readonly: true });

		// when
		const result = db
			.query("SELECT * FROM cookies WHERE host_key LIKE '%akiflow%'")
			.all();
		db.close();

		// then
		expect(result.length).toBe(1);
	});
});

describe("Safari binary cookies mock", () => {
	let tempDir: string;
	let mockCookiePath: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "safari-cookie-test-"));
		mockCookiePath = join(tempDir, "Cookies.binarycookies");

		const cookieData = createMockSafariCookie(
			".akiflow.com",
			"remember_web_abc",
			"jwt_token_here",
		);
		writeFileSync(mockCookiePath, cookieData);
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("imports a valid cookie but ignores lookalike domains", async () => {
		const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.fixtureSignature`;
		const path = join(tempDir, "domains");
		const browser = {
			id: "safari" as const,
			name: "Fixture",
			cookiePath: path,
			indexedDBPath: null,
			encryptionMethod: "binary" as const,
		};
		writeFileSync(
			path,
			createMockSafariCookie(".akiflow.com", "remember_web_a", jwt),
		);
		expect(
			(await extractFromSafari(browser)).map((value) => value.token),
		).toEqual([jwt]);
		writeFileSync(
			path,
			createMockSafariCookie("evilakiflow.com", "remember_web_a", jwt),
		);
		expect(await extractFromSafari(browser)).toEqual([]);
	});

	it("rejects truncated headers and invalid cookie string offsets without throwing", async () => {
		const path = join(tempDir, "malformed");
		const browser = {
			id: "safari" as const,
			name: "Fixture",
			cookiePath: path,
			indexedDBPath: null,
			encryptionMethod: "binary" as const,
		};
		for (const buffer of [
			Buffer.from("cook"),
			Buffer.from("cook\x00\x00\x00\xff"),
			createMockSafariCookie(".akiflow.com", "remember_web_a", "value"),
		]) {
			if (buffer.length > 24) buffer.writeUInt32LE(0xffffffff, 24);
			writeFileSync(path, buffer);
			expect(await extractFromSafari(browser)).toEqual([]);
		}
	});

	it("creates valid binary cookie file with cook magic", async () => {
		// given
		const file = Bun.file(mockCookiePath);
		const buffer = await file.arrayBuffer();
		const bytes = new Uint8Array(buffer);

		// when
		const magic = String.fromCharCode(
			bytes[0]!,
			bytes[1]!,
			bytes[2]!,
			bytes[3]!,
		);

		// then
		expect(magic).toBe("cook");
	});
});

/**
 * Create a minimal Safari binary cookie for testing
 */
function createMockSafariCookie(
	domain: string,
	name: string,
	value: string,
): Buffer {
	const path = "/";

	const domainBytes = Buffer.from(`${domain}\0`);
	const nameBytes = Buffer.from(`${name}\0`);
	const pathBytes = Buffer.from(`${path}\0`);
	const valueBytes = Buffer.from(`${value}\0`);

	const cookieDataSize =
		56 +
		domainBytes.length +
		nameBytes.length +
		pathBytes.length +
		valueBytes.length;

	const cookieBuffer = Buffer.alloc(cookieDataSize);
	let offset = 0;

	cookieBuffer.writeUInt32LE(cookieDataSize, offset);
	offset += 4;
	cookieBuffer.writeUInt32LE(0, offset);
	offset += 4;
	cookieBuffer.writeUInt32LE(0, offset);
	offset += 4;
	cookieBuffer.writeUInt32LE(0, offset);
	offset += 4;

	const stringDataOffset = 56;
	cookieBuffer.writeUInt32LE(stringDataOffset, offset);
	offset += 4;
	cookieBuffer.writeUInt32LE(stringDataOffset + domainBytes.length, offset);
	offset += 4;
	cookieBuffer.writeUInt32LE(
		stringDataOffset + domainBytes.length + nameBytes.length,
		offset,
	);
	offset += 4;
	cookieBuffer.writeUInt32LE(
		stringDataOffset + domainBytes.length + nameBytes.length + pathBytes.length,
		offset,
	);
	offset += 4;

	offset = 56;
	domainBytes.copy(cookieBuffer, offset);
	offset += domainBytes.length;
	nameBytes.copy(cookieBuffer, offset);
	offset += nameBytes.length;
	pathBytes.copy(cookieBuffer, offset);
	offset += pathBytes.length;
	valueBytes.copy(cookieBuffer, offset);

	const pageSize = 8 + 4 + cookieDataSize;
	const pageBuffer = Buffer.alloc(pageSize);
	pageBuffer.writeUInt32LE(0x00000100, 0);
	pageBuffer.writeUInt32LE(1, 4);
	pageBuffer.writeUInt32LE(12, 8);
	cookieBuffer.copy(pageBuffer, 12);

	const headerSize = 8 + 4;
	const totalSize = headerSize + pageSize;
	const result = Buffer.alloc(totalSize);

	result.write("cook", 0);
	result.writeUInt32BE(1, 4);
	result.writeUInt32BE(pageSize, 8);
	pageBuffer.copy(result, 12);

	return result;
}
