import {describe,expect,it} from 'vitest';
import {SqlServerAdapter} from './enterprise-sql-adapters.js';

class CapturingAdapter extends SqlServerAdapter {
  sql='';
  protected override async query(sql:string):Promise<Record<string,unknown>[]> {
    this.sql=sql;return [];
  }
}
describe('SQL Server screen result limits',()=>{
  it('keeps ORDER BY and its table alias in the original SELECT',async()=>{
    const adapter=new CapturingAdapter({});
    await adapter.runSqlReadonly({sql:'SELECT e.id FROM events e ORDER BY e.apply_date DESC',limit:50});
    expect(adapter.sql).toBe('SELECT TOP (50) e.id FROM events e ORDER BY e.apply_date DESC');
  });
  it('caps the outer result even when an inner lookup has TOP 1',async()=>{
    const adapter=new CapturingAdapter({});
    await adapter.runSqlReadonly({sql:'SELECT e.id FROM events e OUTER APPLY (SELECT TOP 1 x.id FROM events x) a ORDER BY e.id',limit:50});
    expect(adapter.sql).toMatch(/^SELECT TOP \(50\)/);
    expect(adapter.sql).toContain('SELECT TOP 1 x.id');
  });
  it.each([['SELECT TOP (10) id FROM events', 'SELECT TOP (10) id FROM events'],
    ['SELECT TOP 100 id FROM events','SELECT TOP (50) id FROM events'],
    ['SELECT DISTINCT id FROM events ORDER BY id','SELECT DISTINCT TOP (50) id FROM events ORDER BY id']])('respects the cap for %s',async(sql,expected)=>{
    const adapter=new CapturingAdapter({});await adapter.runSqlReadonly({sql,limit:50});expect(adapter.sql).toBe(expected);
  });
});
