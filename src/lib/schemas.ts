import { z } from 'zod'

export const requestTypeSchema = z.enum([
  'access',
  'rectification',
  'deletion',
  'withdraw-consent',
  'restriction',
])

export const requestStatusSchema = z.enum([
  'registered',
  'identity-review',
  'processing',
  'review-required',
  'pending-close',
  'completed',
  'rejected',
  'extended',
])

export const regionSchema = z.enum(['cn', 'eu', 'us', 'sg'])

export const identitySchema = z.object({
  status: z.enum(['pending', 'verified', 'insufficient']),
  materialType: z.enum(['masked-id', 'account-ownership', 'authorization-letter', 'none']),
  maskedReference: z.string(),
  protectedDigest: z.string(),
  note: z.string(),
  reviewedAt: z.string().optional(),
})

export const workflowStepSchema = z.object({
  id: z.string(),
  order: z.number(),
  name: z.string(),
  role: z.string(),
  systemId: z.string().optional(),
  status: z.enum(['pending', 'active', 'completed', 'blocked']),
  assignee: z.string(),
  dueAt: z.string(),
  completedAt: z.string().optional(),
  exceptionReason: z.string(),
})

export const evidenceSchema = z.object({
  id: z.string(),
  stepId: z.string(),
  name: z.string(),
  evidenceType: z.enum(['execution-log', 'screenshot', 'signed-record', 'system-response']),
  digest: z.string(),
  uploadedBy: z.string(),
  uploadedAt: z.string(),
  protected: z.literal(true),
})

export const commentSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  author: z.string(),
  content: z.string(),
  createdAt: z.string(),
})

// 跨系统履约凭证：系统每次送达（或失败回报）都只追加一条台账记录
export const credentialReceiptSchema = z.object({
  id: z.string(),
  systemId: z.string(),
  // 凭证幂等键：同一系统内同一凭证（引用 + 处理批次）重复送达只认第一次
  credentialKey: z.string(),
  batch: z.string(),
  // 系统自报的批次序号，用于判定迟到的旧批次
  batchSeq: z.number(),
  outcome: z.enum(['success', 'failure']),
  status: z.enum(['accepted', 'ignored']),
  // 接受或忽略的可审计原因，例如“同一凭证重复送达，只认第一次”
  reason: z.string(),
  credentialRef: z.string(),
  credentialDigest: z.string(),
  detail: z.string(),
  receivedAt: z.string(),
  receivedBy: z.string(),
})

// 跨系统凭证差异：内容不一致、凭证缺失、批次混乱等，处理完前禁止关闭
export const fulfillmentDiscrepancySchema = z.object({
  id: z.string(),
  systemId: z.string(),
  kind: z.enum(['content-mismatch', 'missing-credential', 'batch-order', 'other']),
  description: z.string(),
  raisedAt: z.string(),
  raisedBy: z.string(),
  status: z.enum(['open', 'resolved']),
  resolution: z.string(),
  resolvedAt: z.string().optional(),
  resolvedBy: z.string().optional(),
})

// 单个受影响系统的履约凭证状态
export const systemFulfillmentSchema = z.object({
  systemId: z.string(),
  state: z.enum(['pending', 'succeeded', 'failed', 'confirmed']),
  // 当前处理批次序号：每按原系统重试一次递增，旧批次序号小于该值即视为迟到
  batchSeq: z.number(),
  // 当前重试轮次（含首次）
  attempts: z.number(),
  // 最近一次成功凭证（迟到的重复凭证不覆盖；新批次成功可替换为更新凭证）
  lastSuccessReceiptId: z.string().optional(),
  confirmedAt: z.string().optional(),
  confirmedBy: z.string().optional(),
  lastFailureAt: z.string().optional(),
  lastFailureReason: z.string(),
  receipts: z.array(credentialReceiptSchema),
  retries: z.array(
    z.object({
      round: z.number(),
      batch: z.string(),
      reason: z.string(),
      retriedAt: z.string(),
      retriedBy: z.string(),
    }),
  ),
})

export const auditEntrySchema = z.object({
  id: z.string(),
  requestId: z.string().optional(),
  action: z.string(),
  operator: z.string(),
  detail: z.string(),
  createdAt: z.string(),
})

export const dataSystemSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  dataDomain: z.string(),
  transferMethod: z.string(),
  slaDays: z.number(),
  requestTypes: z.array(requestTypeSchema),
  status: z.enum(['active', 'maintenance', 'retired']),
})

export const privacyRequestSchema = z.object({
  id: z.string(),
  code: z.string(),
  requesterName: z.string(),
  requesterContact: z.string(),
  region: regionSchema,
  type: requestTypeSchema,
  status: requestStatusSchema,
  identity: identitySchema,
  requestedAt: z.string(),
  dueAt: z.string(),
  extendedDays: z.number(),
  duplicateOf: z.string().optional(),
  affectedSystemIds: z.array(z.string()),
  tasks: z.array(workflowStepSchema),
  evidence: z.array(evidenceSchema),
  // 按受影响系统登记的履约凭证台账与差异处理记录
  systemFulfillments: z.array(systemFulfillmentSchema),
  fulfillmentDiscrepancies: z.array(fulfillmentDiscrepancySchema),
  conflicts: z.array(z.string()),
  resultSummary: z.string(),
  closureReason: z.string(),
  audit: z.array(
    auditEntrySchema.omit({ requestId: true }),
  ),
})

export const workspaceStateSchema = z.object({
  requests: z.array(privacyRequestSchema),
  systems: z.array(dataSystemSchema),
  comments: z.array(commentSchema),
  audit: z.array(auditEntrySchema),
  revision: z.number(),
})

export const saveRequestInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  patch: privacyRequestSchema.partial(),
  operator: z.string().default('当前用户'),
})

export const createRequestInputSchema = z.object({
  state: workspaceStateSchema,
  input: z.object({
    requesterName: z.string().min(2),
    requesterContact: z.string().min(5),
    region: regionSchema,
    type: requestTypeSchema,
    affectedSystemIds: z.array(z.string()).min(1),
    identityMaterialType: identitySchema.shape.materialType,
    identityReference: z.string(),
    note: z.string(),
  }),
  operator: z.string().default('客服专员'),
})

export const identityInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  status: z.enum(['verified', 'insufficient']),
  note: z.string(),
  operator: z.string(),
})

export const assignTaskInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  taskId: z.string(),
  assignee: z.string().min(2),
  operator: z.string(),
})

export const taskActionInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  taskId: z.string(),
  action: z.enum(['start', 'complete', 'block']),
  note: z.string(),
  operator: z.string(),
})

export const evidenceInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  taskId: z.string(),
  name: z.string().min(2),
  evidenceType: evidenceSchema.shape.evidenceType,
  operator: z.string(),
})

export const conflictInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  conflict: z.string().min(4),
  operator: z.string(),
})

export const resolveConflictInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  conflictIndex: z.number().int().nonnegative(),
  resolution: z.string().min(4),
  operator: z.string(),
})

export const closeRequestInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  resultSummary: z.string().min(4),
  closureReason: z.string(),
  operator: z.string(),
})

export const extendRequestInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  days: z.number().int().min(1).max(90),
  reason: z.string().min(4),
  operator: z.string(),
})

export const commentInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  content: z.string().min(2),
  operator: z.string(),
})

export const recordExportInputSchema = z.object({
  state: workspaceStateSchema,
  scope: z.string(),
  count: z.number().int().nonnegative(),
  operator: z.string(),
})

export const credentialInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  systemId: z.string(),
  outcome: z.enum(['success', 'failure']),
  batch: z.string().min(1),
  batchSeq: z.number().int().positive(),
  credentialRef: z.string(),
  detail: z.string(),
  operator: z.string(),
})

export const retryFulfillmentInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  // 不传 systemId 时按原系统重试全部仍失败的系统
  systemId: z.string().optional(),
  reason: z.string().min(2),
  operator: z.string(),
})

export const confirmSystemInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  systemId: z.string(),
  note: z.string(),
  operator: z.string(),
})

export const discrepancyInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  systemId: z.string(),
  kind: fulfillmentDiscrepancySchema.shape.kind,
  description: z.string().min(4),
  operator: z.string(),
})

export const resolveDiscrepancyInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  discrepancyId: z.string(),
  resolution: z.string().min(4),
  operator: z.string(),
})

export type RequestType = z.infer<typeof requestTypeSchema>
export type RequestStatus = z.infer<typeof requestStatusSchema>
export type Region = z.infer<typeof regionSchema>
export type IdentityCheck = z.infer<typeof identitySchema>
export type WorkflowStep = z.infer<typeof workflowStepSchema>
export type ExecutionEvidence = z.infer<typeof evidenceSchema>
export type ReviewComment = z.infer<typeof commentSchema>
export type AuditEntry = z.infer<typeof auditEntrySchema>
export type DataSystem = z.infer<typeof dataSystemSchema>
export type CredentialReceipt = z.infer<typeof credentialReceiptSchema>
export type FulfillmentDiscrepancy = z.infer<typeof fulfillmentDiscrepancySchema>
export type SystemFulfillment = z.infer<typeof systemFulfillmentSchema>
export type PrivacyRequest = z.infer<typeof privacyRequestSchema>
export type WorkspaceState = z.infer<typeof workspaceStateSchema>

export const requestTypeLabels: Record<RequestType, string> = {
  access: '访问',
  rectification: '更正',
  deletion: '删除',
  'withdraw-consent': '撤回同意',
  restriction: '限制处理',
}

export const requestStatusLabels: Record<RequestStatus, string> = {
  registered: '已登记',
  'identity-review': '身份核验中',
  processing: '履约处理中',
  'review-required': '复核队列',
  'pending-close': '待关闭',
  completed: '已完成',
  rejected: '已拒绝',
  extended: '已延期',
}

export const regionLabels: Record<Region, string> = {
  cn: '中国大陆',
  eu: '欧盟',
  us: '美国加州',
  sg: '新加坡',
}

export const systemStatusLabels: Record<DataSystem['status'], string> = {
  active: '在用',
  maintenance: '维护中',
  retired: '已退役',
}

export const fulfillmentStateLabels: Record<SystemFulfillment['state'], string> = {
  pending: '待处理',
  succeeded: '已成功',
  failed: '处理失败',
  confirmed: '已确认',
}

export const credentialOutcomeLabels: Record<CredentialReceipt['outcome'], string> = {
  success: '成功凭证',
  failure: '失败回报',
}

export const discrepancyKindLabels: Record<FulfillmentDiscrepancy['kind'], string> = {
  'content-mismatch': '凭证内容不一致',
  'missing-credential': '凭证缺失',
  'batch-order': '批次顺序异常',
  other: '其他差异',
}
