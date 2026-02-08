import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import {
  getSecretRow,
  upsertSecretRow,
  deleteSecretRow,
} from "./db";
import { SecretsManagerClient, GetSecretValueCommand, CreateSecretCommand, PutSecretValueCommand, DeleteSecretCommand } from "@aws-sdk/client-secrets-manager";

export interface SecretProvider {
  setSecret(tenantId: string, key: string, value: string): Promise<void>;
  getSecret(tenantId: string, key: string): Promise<string | undefined>;
  deleteSecret(tenantId: string, key: string): Promise<void>;
  hasSecret(tenantId: string, key: string): Promise<boolean>;
}

const MIN_KEY_BYTES = 32; // AES-256 requires 32-byte key
const ENC_KEY_RAW = process.env.SECRET_ENCRYPTION_KEY || "";
const ENC_KEY_BUF = Buffer.from(ENC_KEY_RAW, "utf8");
const KEY_BUF =
  ENC_KEY_RAW && ENC_KEY_BUF.length >= MIN_KEY_BYTES
    ? ENC_KEY_BUF.subarray(0, MIN_KEY_BYTES)
    : null;

const secretManagerMode = (process.env.SECRET_MANAGER || "db").toLowerCase();
if (secretManagerMode === "db" && !KEY_BUF) {
  const msg = !ENC_KEY_RAW
    ? "SECRET_ENCRYPTION_KEY is required when SECRET_MANAGER=db"
    : `SECRET_ENCRYPTION_KEY must be at least ${MIN_KEY_BYTES} bytes when SECRET_MANAGER=db (got ${ENC_KEY_BUF.length})`;
  throw new Error(msg);
}
const IV_LEN = 12; // AES-256-GCM

function encrypt(value: string): string {
  if (!KEY_BUF) throw new Error("SECRET_ENCRYPTION_KEY is not set");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", KEY_BUF, iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(encoded: string): string {
  if (!KEY_BUF) throw new Error("SECRET_ENCRYPTION_KEY is not set");
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.slice(0, IV_LEN);
  const tag = raw.slice(IV_LEN, IV_LEN + 16);
  const data = raw.slice(IV_LEN + 16);
  const decipher = createDecipheriv("aes-256-gcm", KEY_BUF, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

class EncryptedDbSecretProvider implements SecretProvider {
  async setSecret(tenantId: string, key: string, value: string): Promise<void> {
    const cipher = encrypt(value);
    await upsertSecretRow({ tenantId, key, cipher });
  }

  async getSecret(tenantId: string, key: string): Promise<string | undefined> {
    const row = await getSecretRow(tenantId, key);
    if (!row) return undefined;
    return decrypt(row.cipher);
  }

  async deleteSecret(tenantId: string, key: string): Promise<void> {
    await deleteSecretRow(tenantId, key);
  }

  async hasSecret(tenantId: string, key: string): Promise<boolean> {
    const row = await getSecretRow(tenantId, key);
    return !!row;
  }
}

class EnvSecretProvider implements SecretProvider {
  private prefix = (process.env.SECRET_ENV_PREFIX || "TENANT_").toUpperCase();

  private envKey(tenantId: string, key: string): string {
    return `${this.prefix}${tenantId}_${key}`.toUpperCase();
  }

  async setSecret(): Promise<void> {
    throw new Error("Env secret provider is read-only. Set secrets via environment.");
  }

  async getSecret(tenantId: string, key: string): Promise<string | undefined> {
    return process.env[this.envKey(tenantId, key)];
  }

  async deleteSecret(): Promise<void> {
    throw new Error("Env secret provider is read-only.");
  }

  async hasSecret(tenantId: string, key: string): Promise<boolean> {
    return typeof process.env[this.envKey(tenantId, key)] === "string";
  }
}

class AwsSecretProvider implements SecretProvider {
  private client: SecretsManagerClient;
  private prefix: string;

  constructor() {
    const region = process.env.SECRET_AWS_REGION || process.env.AWS_REGION || "us-east-1";
    this.client = new SecretsManagerClient({ region });
    this.prefix = process.env.SECRET_AWS_PREFIX || "veralux/";
  }

  private name(tenantId: string, key: string): string {
    const safeTenant = tenantId.replace(/[^a-zA-Z0-9-_]/g, "_");
    const safeKey = key.replace(/[^a-zA-Z0-9-_]/g, "_");
    return `${this.prefix}${safeTenant}/${safeKey}`;
  }

  async setSecret(tenantId: string, key: string, value: string): Promise<void> {
    const name = this.name(tenantId, key);
    try {
      await this.client.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: value,
        })
      );
    } catch (err: any) {
      if (err && err.name === "ResourceExistsException") {
        await this.client.send(
          new PutSecretValueCommand({
            SecretId: name,
            SecretString: value,
          })
        );
      } else {
        throw err;
      }
    }
  }

  async getSecret(tenantId: string, key: string): Promise<string | undefined> {
    const name = this.name(tenantId, key);
    try {
      const res = await this.client.send(
        new GetSecretValueCommand({ SecretId: name })
      );
      return res.SecretString || undefined;
    } catch (err: any) {
      if (err && (err.name === "ResourceNotFoundException" || err.$metadata?.httpStatusCode === 404)) {
        return undefined;
      }
      throw err;
    }
  }

  async deleteSecret(tenantId: string, key: string): Promise<void> {
    const name = this.name(tenantId, key);
    try {
      await this.client.send(
        new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true })
      );
    } catch (err: any) {
      if (err && (err.name === "ResourceNotFoundException" || err.$metadata?.httpStatusCode === 404)) {
        return;
      }
      throw err;
    }
  }

  async hasSecret(tenantId: string, key: string): Promise<boolean> {
    const val = await this.getSecret(tenantId, key);
    return val != null;
  }
}

function selectProvider(): SecretProvider {
  const mode = (process.env.SECRET_MANAGER || "db").toLowerCase();
  if (mode === "env") return new EnvSecretProvider();
  if (mode === "aws") return new AwsSecretProvider();
  return new EncryptedDbSecretProvider();
}

export const secretStore: SecretProvider = selectProvider();
