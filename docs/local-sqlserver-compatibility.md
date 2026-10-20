# Local SQL Server Compatibility

This local deployment defaults SQL Server datasources to encrypted connections
with `encrypt=true` and `trustServerCertificate=true`. This supports the existing
internal SQL Server 2012 SP4 instance without changing that server.

Host, port, database, username and password are sufficient for a new connection.
The backend adapter, datasource parameter defaults, and Web create/edit forms
share these defaults. Explicit `trustServerCertificate=false` remains available
and is preserved on save for servers that require certificate validation.

This is a persistent, datasource-specific compatibility policy, not a temporary
environment-variable override. It retains TLS transport encryption but skips
server certificate identity validation. It does not change Node.js global TLS
settings or other database adapters. It does not repair the remote certificate.

Verification against the existing SQL Server 2012 SP4 instance includes new
connections using only basic connection parameters, a read-only `SELECT 1`, and
the existing datasource's connection test after restarting DataFoundry.

These are local source changes. Preserve/reapply them when replacing the source
tree with an upstream download. Do not include credentials in this document.
