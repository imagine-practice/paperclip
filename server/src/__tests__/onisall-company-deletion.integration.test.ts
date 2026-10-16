import { randomUUID, createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb, companies, projects, pipelines, pipelineStages, pipelineCases,
  onisallInputSnapshots, onisallIntakeDrafts, onisallInputObservations,
  onisallNativeBindings, onisallPreparationBaselines, onisallSchemaVersions,
  onisallFrozenSchemaSets, onisallFrozenSchemaSetMembers,
  type Db,
} from "@paperclipai/db";

// Only the agent worker bridge is simulated. SQL, FK constraints, transaction
// commit/rollback and deleteCompany (including its real purge participant) run.
vi.mock("../services/agent-lifecycle.js", () => ({
  createAgentLifecycle: () => ({ terminateAgent: async () => undefined }),
  scheduleAgentLifecycle: async () => undefined,
}));
import { deleteCompany } from "../services/company-deletion.js";

const suppliedUrl = process.env.ONS95_COMPANY_DELETE_DATABASE_URL;
const suppliedSwitch = process.env.ONS95_COMPANY_DELETE_INTEGRATION;
const requested = suppliedUrl !== undefined || suppliedSwitch !== undefined;
const onisallTables = [
  "onisall_frozen_schema_set_members", "onisall_frozen_schema_sets", "onisall_schema_versions",
  "onisall_preparation_baselines", "onisall_native_bindings", "onisall_input_observations",
  "onisall_intake_drafts", "onisall_input_snapshots",
] as const;
const companyTables = [...onisallTables, "projects", "pipelines", "pipeline_cases"] as const;
type Executor = Pick<Db, "execute">;
type State = Record<string, unknown[]>;
const hash = createHash("sha256").update("ons95-public-integration-fixture").digest("hex");

function targetUrl(): URL {
  let target: URL;
  try { target = new URL(suppliedUrl ?? ""); } catch { throw new Error("ons95_delete_target_not_admitted"); }
  if (suppliedSwitch !== "1" || !["postgres:", "postgresql:"].includes(target.protocol)
      || target.hostname !== "127.0.0.1" || !/^[1-9][0-9]{0,4}$/.test(target.port)
      || Number(target.port) > 65535 || target.search !== "" || target.hash !== ""
      || !/^\/ons95_company_delete_[a-f0-9]{32}$/.test(target.pathname)) {
    throw new Error("ons95_delete_target_not_admitted");
  }
  return target;
}

async function state(executor: Executor, companyId: string): Promise<State> {
  const result: State = {};
  for (const table of ["companies", ...companyTables]) {
    const key = table === "companies" ? "id" : "company_id";
    const rows = await executor.execute(sql`select to_jsonb(t) as row
      from ${sql.identifier("public")}.${sql.identifier(table)} t
      where ${sql.identifier(key)} = ${companyId} order by to_jsonb(t)::text`);
    result[table] = Array.from(rows as unknown as { row: unknown }[], entry => entry.row);
  }
  const stages = await executor.execute(sql`select to_jsonb(s) as row from public.pipeline_stages s
    join public.pipelines p on p.id = s.pipeline_id where p.company_id = ${companyId}
    order by to_jsonb(s)::text`);
  result.pipeline_stages = Array.from(stages as unknown as { row: unknown }[], entry => entry.row);
  return result;
}

async function seed(db: Db): Promise<string> {
  const companyId = randomUUID(), projectId = randomUUID(), pipelineId = randomUUID();
  const stageId = randomUUID(), caseId = randomUUID(), snapshotId = randomUUID();
  const intakeId = randomUUID(), bindingId = randomUUID(), schemaId = randomUUID(), setId = randomUUID();
  await db.transaction(async tx => {
    await tx.insert(companies).values({ id: companyId, name: "ONS95 synthetic company",
      issuePrefix: `D${companyId.replaceAll("-", "").slice(0, 12).toUpperCase()}` });
    await tx.insert(projects).values({ id: projectId, companyId, name: "ONS95 project" });
    await tx.insert(pipelines).values({ id: pipelineId, companyId, projectId,
      key: "ons95", name: "ONS95 pipeline" });
    await tx.insert(pipelineStages).values({ id: stageId, pipelineId, key: "work",
      name: "Work", kind: "working", position: 0 });
    await tx.insert(pipelineCases).values({ id: caseId, companyId, pipelineId, stageId,
      caseKey: "ons95-case", title: "ONS95 case" });
    await tx.insert(onisallInputSnapshots).values({ id: snapshotId, companyId,
      protocol: "onisall.input-text.v1", sha256: hash, byteSize: 2, lineCount: 1, hasBom: false,
      provider: "local_disk", objectKey: `ons95/${snapshotId}` });
    await tx.insert(onisallIntakeDrafts).values({ id: intakeId, companyId,
      businessKey: "ons95-intake", requestHash: hash, goal: "Synthetic FK fixture",
      sourceLabel: "ONS95", initialSnapshotId: snapshotId, bindingStatus: "bound",
      createdByUserId: "ons95-synthetic-user" });
    await tx.insert(onisallInputObservations).values({ companyId, intakeId, snapshotId,
      requestKey: "ons95-observation", observedByUserId: "ons95-synthetic-user" });
    await tx.insert(onisallNativeBindings).values({ id: bindingId, companyId, intakeId,
      snapshotId, inputSha256: hash, pipelineId, projectId, caseId, entryStageKey: "work",
      configurationHash: hash, requestHash: hash, createdByUserId: "ons95-synthetic-user" });
    await tx.insert(onisallPreparationBaselines).values({ companyId, intakeId, bindingId,
      snapshotId, inputSha256: hash, pipelineId, projectId, caseId, caseVersion: 1,
      stageId, stageKey: "work", bindingRevision: 1, bindingConfigurationHash: hash,
      workflowHash: hash, workflowSnapshot: "{}", baselineHash: hash,
      requestKey: "ons95-baseline", createdByUserId: "ons95-synthetic-user" });
    await tx.insert(onisallSchemaVersions).values({ id: schemaId, companyId,
      registryKey: "ons95-schema", revision: "ons95-r1", sha256: hash, byteSize: 2, content: "{}" });
    await tx.insert(onisallFrozenSchemaSets).values({ id: setId, companyId,
      manifest: "[]", manifestSha256: hash, schemaCount: 1, totalByteSize: 2,
      createdByUserId: "ons95-synthetic-user" });
    await tx.insert(onisallFrozenSchemaSetMembers).values({ companyId, setId, schemaId, position: 0 });
  });
  return companyId;
}

describe.skipIf(!requested)("ONS95 real migrated database company deletion", () => {
  let db: Db | undefined;
  beforeAll(async () => {
    const target = targetUrl();
    db = createDb(suppliedUrl!, { maxConnections: 2, applicationName: "ons95-company-deletion-test" });
    const rows = await db.execute(sql`select current_database() as database,
      host(inet_server_addr()) as address, inet_server_port() as port`);
    const identity = (rows as unknown as { database: string; address: string; port: number }[])[0];
    expect(identity?.database).toBe(target.pathname.slice(1));
    expect(identity?.address).toBe("127.0.0.1");
    expect(identity?.port).toBe(Number(target.port));
  });
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); });

  it("deletes all eight OnisAll FK dependents for A and preserves B exactly", async () => {
    const a = await seed(db!), b = await seed(db!);
    const beforeA = await state(db!, a), beforeB = await state(db!, b);
    for (const rows of Object.values(beforeA)) expect(rows).toHaveLength(1);
    for (const rows of Object.values(beforeB)) expect(rows).toHaveLength(1);
    expect(await deleteCompany(db!, a)).toMatchObject({ id: a });
    for (const rows of Object.values(await state(db!, a))) expect(rows).toHaveLength(0);
    expect(await state(db!, b)).toEqual(beforeB);
    // Only successful assertions reach fixture cleanup. Failures retain rows for
    // the external owned test-DB controller; this test never starts/stops PG.
    expect(await deleteCompany(db!, b)).toMatchObject({ id: b });
  });

  it("rolls back actual OnisAll deletes when the final company delete is refused", async () => {
    const a = await seed(db!), b = await seed(db!);
    const beforeA = await state(db!, a), beforeB = await state(db!, b);
    const fault = new Error("ons95_injected_final_company_delete");
    let observedEmptyInsideTransaction = false;
    const faultDb = new Proxy(db!, { get(target, key) {
      if (key === "transaction") return (async (work, options) => target.transaction(async tx => {
        const faultTx = new Proxy(tx, { get(transaction, property) {
          if (property === "delete") return (table: unknown) => {
            if (table === companies) throw fault;
            return Reflect.apply(transaction.delete, transaction, [table]);
          };
          const value = Reflect.get(transaction, property, transaction);
          return typeof value === "function" ? value.bind(transaction) : value;
        } });
        try { return await work(faultTx); }
        catch (error) {
          if (error === fault) {
            const inside = await state(tx, a);
            for (const table of onisallTables) expect(inside[table]).toHaveLength(0);
            expect(inside.companies).toHaveLength(1);
            observedEmptyInsideTransaction = true;
          }
          throw error; // The real outer transaction performs ROLLBACK.
        }
      }, options)) as Db["transaction"];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(deleteCompany(faultDb, a)).rejects.toBe(fault);
    expect(observedEmptyInsideTransaction).toBe(true);
    expect(await state(db!, a)).toEqual(beforeA);
    expect(await state(db!, b)).toEqual(beforeB);
    // No claim about upstream pre-transaction agent termination/scheduling:
    // those two bridges are simulated and this fixture contains no agents.
    expect(await deleteCompany(db!, a)).toMatchObject({ id: a });
    expect(await deleteCompany(db!, b)).toMatchObject({ id: b });
  });

  it("returns null for a missing company without changing existing companies", async () => {
    const company = await seed(db!);
    const before = await state(db!, company);
    expect(await deleteCompany(db!, randomUUID())).toBeNull();
    expect(await state(db!, company)).toEqual(before);
    expect(await deleteCompany(db!, company)).toMatchObject({ id: company });
  });
});
