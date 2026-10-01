/**
 * 管理操作稽核(DATABASE.md §5):與業務變更在同一交易內寫入 gw.audit_log。
 * CLI 只有操作人名稱;管理 API 另記使用者 ID、來源 IP 與 requestId。
 */
import { auditLog } from '../../db/schema/index.js';
import type { Tx } from './route-import.js';

export interface AuditActor {
  /** 工號、client:{API Key 代碼} 或 cli:{OS 使用者} */
  name: string;
  userId?: number | null;
  ip?: string | null;
  requestId?: string | null;
}

export async function writeAudit(
  tx: Tx,
  actor: AuditActor,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
    actorIp: actor.ip ?? null,
    action,
    entityType,
    entityId,
    beforeJson: before == null ? null : JSON.stringify(before),
    afterJson: after == null ? null : JSON.stringify(after),
    requestId: actor.requestId ?? null,
  });
}
