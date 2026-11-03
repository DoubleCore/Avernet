import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import Database from "better-sqlite3";
import JSZip from "jszip";
import { once } from "node:events";
import { SqliteDatabase, runMigrations } from "@avernet/clawweb-shared/server/db";
import { EvolveRepository } from "../../repositories/evolve-repository.js";
import { StageSkillRepository } from "../../repositories/stage-skill-repository.js";
import { createEvolveRouter } from "../evolve.js";

let db: SqliteDatabase, repo: EvolveRepository, base: string;
let server: ReturnType<express.Application["listen"]>;
const objects = new Map<string, Buffer>();
const dispatch = vi.fn(async () => ({ runId: "run", sessionId: "session" }));
const store = {
  putObject: vi.fn(async (key: string, bytes: Buffer | Uint8Array | string) => { objects.set(key, Buffer.from(bytes)); return { etag: null }; }),
  getObject: vi.fn(async (key: string) => { if (!objects.has(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" }); return { content: objects.get(key)!, contentType: null, etag: null }; }),
  createSignedUrl: vi.fn(async (key: string) => `https://artifact.example.test/${key}`),
};
beforeEach(async () => {
  objects.clear(); dispatch.mockClear();
  db = new SqliteDatabase(new Database(":memory:")); await runMigrations(db, "sqlite");
  repo = new EvolveRepository(db);
  await db.exec(`CREATE TABLE ac_entity_device_binding (id INTEGER PRIMARY KEY, device_provider TEXT, device_id TEXT, device_props TEXT, status TEXT, env TEXT)`);
  await db.exec(`CREATE TABLE ac_bots (id INTEGER PRIMARY KEY, bot_id TEXT, bot_name TEXT, owner_id TEXT, entity_id TEXT, entity_type TEXT, is_delete INTEGER, active_engine TEXT, bot_type TEXT, status TEXT, binding_id INTEGER, env TEXT)`);
  await db.exec(`INSERT INTO ac_entity_device_binding VALUES (1,'arca','sandbox',NULL,'active','pre')`);
  await db.exec(`INSERT INTO ac_bots VALUES (1,'bot','Bot','owner','owner','staff',0,'openclaw','personal','active',1,'pre')`);
  const app = express(); app.use(express.json());
  app.use("/api/evolve", createEvolveRouter(repo, { artifactStore: store, artifactUrlStore: store, dispatch,
    stageSkillRepo: new StageSkillRepository(db), modelConfig: { defaultModel: "test-model", models: ["test-model"] } }));
  server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/evolve`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); });
async function request(path: string, body?: Record<string, unknown> | FormData, owner = "owner", key = "create-1") {
  return fetch(base + path, { method: body ? "POST" : "GET", headers: { "X-User-Id": owner,
    "Idempotency-Key": key, ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
}
async function upload() {
  const bytes = await new JSZip().file("规范/日报.md", "金额单位为元，不足两位补零", { createFolders: false }).generateAsync({ type: "uint8array", compression: "STORE" });
  const form = new FormData(); form.set("package", new Blob([bytes as Uint8Array<ArrayBuffer>]), "materials.zip");
  const response = await request("/reference-materials/uploads", form);
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<{ materialId: string }>;
}
function task(uploadId?: string) { return { taskType: "full", taskName: "参考业务材料优化", userId: "owner", botId: "bot", botEnv: "pre",
  inputMode: "direct_goal", goal: "完善日报输出", model: "test-model", maxRounds: 2,
  ...(uploadId ? { referenceMaterialsUploadId: uploadId } : {}) }; }

it("uploads, creates once, and delivers the same signed material to native Plan and subsequent Optimize", async () => {
  const uploaded = await upload();
  const created = await request("/tasks", task(uploaded.materialId));
  expect(created.status, await created.clone().text()).toBe(201);
  const result = await created.json();
  const frozen = result.config.reference_materials;
  expect(frozen.taskId).toBe(result.task_id);
  const steps = await repo.listSteps(result.task_id);
  expect(steps[0].command).toContain("--reference-materials-version 1");
  const plan = await (await request(`/internal/tasks/${result.task_id}/steps/${steps[0].step_id}/input`)).json();
  expect(plan.reference_materials.sha256).toBe(frozen.sha256);
  expect(plan.reference_materials.download.url).toContain(frozen.objectKey);
  const optimize = await repo.createStep({ stepId: "STEP-OPT", taskId: result.task_id, stepType: "optimize", stepNo: 2, roundNo: 2, command: "/optimize" });
  const next = await (await request(`/internal/tasks/${result.task_id}/steps/${optimize.step_id}/input`)).json();
  expect(next.reference_materials).toEqual(plan.reference_materials);
  const replay = await request("/tasks", task(uploaded.materialId));
  expect(replay.status).toBe(200);
  expect((await replay.json()).task_id).toBe(result.task_id);
  expect(dispatch).toHaveBeenCalledTimes(1);
  const view = await request(`/tasks/${result.task_id}/reference-materials`);
  expect((await view.json()).files[0].path).toBe("规范/日报.md");
  expect((await request(`/tasks/${result.task_id}/reference-materials`, undefined, "stranger")).status).toBe(403);
});
it("rejects a foreign upload, forged identity and unsupported task type without dispatching", async () => {
  const uploaded = await upload();
  const foreign = await request("/tasks", { ...task(uploaded.materialId), userId: "other" }, "other");
  expect(foreign.ok).toBe(false);
  const unsupported = await request("/tasks", { ...task(uploaded.materialId), taskType: "diagnose" });
  expect(unsupported.status).toBe(422);
  const missingKey = await request("/tasks", task(uploaded.materialId), "owner", "");
  expect(missingKey.status).toBe(400);
  expect(dispatch).not.toHaveBeenCalled();
});
it("handles concurrent creation retries with one Task and one initial dispatch", async () => {
  const uploaded = await upload();
  const responses = await Promise.all([request("/tasks", task(uploaded.materialId)), request("/tasks", task(uploaded.materialId))]);
  expect(responses.every(response => response.ok)).toBe(true);
  const results = await Promise.all(responses.map(response => response.json()));
  expect(results[0].task_id).toBe(results[1].task_id);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
it("keeps tasks without materials on the existing command/input path", async () => {
  const response = await request("/tasks", task());
  expect(response.status, await response.clone().text()).toBe(201);
  const result = await response.json();
  expect(result.config).not.toHaveProperty("reference_materials");
  const steps = await repo.listSteps(result.task_id);
  expect(steps[0].command).not.toContain("reference-materials-version");
});

it("delivers the same optional resource through a custom Stage input without persisting signed URLs", async () => {
  const uploaded = await upload();
  const created = await request("/tasks", task(uploaded.materialId));
  const result = await created.json();
  const stages = new StageSkillRepository(db);
  await stages.createImplementation({ implementationId: "IMPL-MATERIAL", stageSkillId: "SKILL-MATERIAL", ownerUserId: "owner",
    displayName: "材料预处理", stage: "plan", mode: "preprocess", versionNo: 1,
    packageRef: "oss://clawevolve-artifacts/stage-implementations/material/package.zip",
    packageSha256: "a".repeat(64), staticValidation: { status: "passed" } });
  await stages.registerImplementation("IMPL-MATERIAL");
  const config = { ...result.config, stageExtensions: { plan: { preprocess: { enabled: true, implementationId: "IMPL-MATERIAL", ownerUserId: "owner" } } } };
  await db.exec("UPDATE ce_tasks SET config_json = ? WHERE task_id = ?", [JSON.stringify(config), result.task_id]);
  await repo.createStep({ taskId: result.task_id, stepId: "STEP-CUSTOM", stepType: "stage_extension", stepNo: 2, command: "/stage" });
  await stages.createExtensionRun({ taskId: result.task_id, stepId: "STEP-CUSTOM", stage: "plan", mode: "preprocess", implementationId: "IMPL-MATERIAL" });
  const response = await request(`/internal/tasks/${result.task_id}/steps/STEP-CUSTOM/input`);
  expect(response.status, await response.clone().text()).toBe(200);
  const input = await response.json();
  expect(input.protocolVersion).toBe("clawevolve.stage-runtime/v1");
  expect(input.input.reference_materials.sha256).toBe(result.config.reference_materials.sha256);
  expect(input.input.reference_materials.download.method).toBe("GET");
  expect((await repo.findTask(result.task_id))!.config_json).not.toContain("https://artifact");
});

it("provides native Hardening businessInput with the prepared target and task reference materials", async () => {
  const uploaded = await upload();
  const created = await request("/tasks", task(uploaded.materialId));
  const result = await created.json();
  const sha256 = "a".repeat(64), workspacePath = `/home/admin/.openclaw/clawevolve_workspaces/${result.task_id}/workspace`;
  const config = { ...result.config, targetSkill: { assetId: "asset", skillId: "daily", name: "daily",
    baseline: { ref: "oss://clawevolve-artifacts/baseline.zip", sha256 }, candidate: {
      ref: "oss://clawevolve-artifacts/candidate.zip", prepared: { workspacePath,
        skillPath: `${workspacePath}/skills/skills-local/daily`, preparedByStepId: "PREP", baselineSha256: sha256 } } } };
  await db.exec("UPDATE ce_tasks SET task_type = 'hardening', config_json = ? WHERE task_id = ?", [JSON.stringify(config), result.task_id]);
  await repo.createStep({ taskId: result.task_id, stepId: "STEP-HARDEN", stepType: "hardening", stepNo: 2, command: "/harden" });
  const response = await request(`/internal/tasks/${result.task_id}/steps/STEP-HARDEN/input`);
  expect(response.status, await response.clone().text()).toBe(200);
  const input = await response.json();
  expect(input.businessInput.reference_materials.sha256).toBe(result.config.reference_materials.sha256);
  expect(input.businessInput.reference_materials.download.method).toBe("GET");
  expect(input.businessInput.target_skill.path).toBe(`${workspacePath}/skills/skills-local/daily`);
});
