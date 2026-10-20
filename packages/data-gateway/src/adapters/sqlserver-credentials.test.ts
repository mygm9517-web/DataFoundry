import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlServerAdapter } from "./enterprise-sql-adapters.js";

const captures = vi.hoisted(() => ({configs: [] as Record<string, unknown>[]}));
vi.mock("mssql", () => ({default:{ConnectionPool:class {
  constructor(config:Record<string,unknown>){captures.configs.push(config);}
  async connect() {}
  request(){return {input(){},async query(){return {recordset:[{connection_ok:1}]};}};}
  async close() {}
}}}));

describe("SQL Server credential names", () => {
  beforeEach(()=>{captures.configs.length=0;});
  const config={host:"db.test",database:"test",password:"test-password"};
  it("accepts the legacy mssql user field",async()=>{
    const result=await new SqlServerAdapter({...config,user:"legacy-user"}).runSqlReadonly({sql:"SELECT 1 AS connection_ok",limit:1});
    expect(result.rows).toEqual([[1]]);
    expect(captures.configs[0]?.user).toBe("legacy-user");
  });
  it("prefers the canonical username when both fields exist",async()=>{
    await new SqlServerAdapter({...config,user:"legacy-user",username:"current-user"}).runSqlReadonly({sql:"SELECT 1",limit:1});
    expect(captures.configs[0]?.user).toBe("current-user");
  });
  it("still rejects a configuration with neither username nor user",async()=>{
    await expect(new SqlServerAdapter(config).runSqlReadonly({sql:"SELECT 1",limit:1}))
      .rejects.toThrow("Missing string config: username");
    expect(captures.configs).toHaveLength(0);
  });
});
