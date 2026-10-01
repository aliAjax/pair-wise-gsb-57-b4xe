import type {
  IdentityCheck,
  PrivacyRequest,
  RequestStatus,
  RequestType,
  SystemFulfillment,
  WorkspaceState,
} from '@/types/domain'
import { addDays, buildWorkflowSteps, responseDays } from './workflow'

const cloneState = (state: WorkspaceState): WorkspaceState => structuredClone(state)
const now = () => new Date().toISOString()
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

function digest(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `PD-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function maskCredential(value: string): string {
  const reference = value.trim()
  if (reference.length <= 6) return `${reference.slice(0, 2)}****`
  return `${reference.slice(0, 4)}****${reference.slice(-2)}`
}

function newFulfillment(systemId: string): SystemFulfillment {
  return {
    systemId,
    status: 'awaiting',
    currentBatchSeq: 1,
    attempts: 0,
    retryCount: 0,
    lastSuccess: null,
    lastFailureNote: '',
  }
}

/** 以受影响系统清单为准对齐履约记录：新增系统补建，移除系统保留台账但不参与关闭判断。 */
function syncFulfillments(request: PrivacyRequest) {
  const byId = new Map(request.systemFulfillments.map((entry) => [entry.systemId, entry]))
  request.systemFulfillments = request.affectedSystemIds.map(
    (systemId) => byId.get(systemId) ?? newFulfillment(systemId),
  )
}

/** 凭证、任务或冲突变化后重算请求状态；已确认系统不因失败通知退回待处理。 */
function deriveStatus(request: PrivacyRequest): RequestStatus {
  if (request.status === 'completed' || request.status === 'rejected') return request.status
  if (request.identity.status !== 'verified' || request.conflicts.length > 0) {
    return 'review-required'
  }
  const allConfirmed =
    request.affectedSystemIds.length > 0 &&
    request.systemFulfillments.length === request.affectedSystemIds.length &&
    request.systemFulfillments.every((entry) => entry.status === 'confirmed')
  const requiredTasks = request.tasks.filter((task) => !task.id.endsWith('-close'))
  const allTasksDone =
    requiredTasks.length > 0 && requiredTasks.every((task) => task.status === 'completed')
  if (allConfirmed && allTasksDone) return 'pending-close'
  return request.status === 'extended' ? 'extended' : 'processing'
}

export function allSystemsConfirmed(request: PrivacyRequest): boolean {
  return (
    request.affectedSystemIds.length > 0 &&
    request.systemFulfillments.length === request.affectedSystemIds.length &&
    request.systemFulfillments.every((entry) => entry.status === 'confirmed' && entry.lastSuccess)
  )
}

function appendAudit(
  state: WorkspaceState,
  request: PrivacyRequest,
  action: string,
  operator: string,
  detail: string,
) {
  const entry = {
    id: id('audit'),
    requestId: request.id,
    action,
    operator,
    detail,
    createdAt: now(),
  }
  state.audit.unshift(entry)
  request.audit.unshift({
    id: entry.id,
    action,
    operator,
    detail,
    createdAt: entry.createdAt,
  })
}

function mutateRequest(
  state: WorkspaceState,
  requestId: string,
  mutation: (request: PrivacyRequest, draft: WorkspaceState) => void,
  audit: { action: string; operator: string; detail: string },
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  mutation(request, draft)
  appendAudit(draft, request, audit.action, audit.operator, audit.detail)
  draft.revision += 1
  return draft
}

export interface CreateRequestInput {
  requesterName: string
  requesterContact: string
  region: keyof typeof responseDays
  type: RequestType
  affectedSystemIds: string[]
  identityMaterialType: IdentityCheck['materialType']
  identityReference: string
  note: string
}

export function createRequest(
  state: WorkspaceState,
  input: CreateRequestInput,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const requestedAt = now()
  const dueAt = addDays(new Date(requestedAt), responseDays[input.region]).toISOString()
  const duplicate = draft.requests.find(
    (request) =>
      request.requesterContact === input.requesterContact &&
      request.type === input.type &&
      !['completed', 'rejected'].includes(request.status),
  )
  const identityInsufficient =
    input.identityMaterialType === 'none' || input.identityReference.trim().length < 6
  const status: RequestStatus = identityInsufficient || duplicate ? 'review-required' : 'identity-review'
  const nextNumber =
    Math.max(
      0,
      ...draft.requests.map((request) => Number(request.code.split('-').at(-1)) || 0),
    ) + 1
  const requestId = id('request')
  const request: PrivacyRequest = {
    id: requestId,
    code: `DSR-2026-${String(nextNumber).padStart(3, '0')}`,
    requesterName: input.requesterName.trim(),
    requesterContact: input.requesterContact.trim(),
    region: input.region,
    type: input.type,
    status,
    identity: {
      status: identityInsufficient ? 'insufficient' : 'pending',
      materialType: input.identityMaterialType,
      maskedReference: input.identityReference.trim(),
      protectedDigest: digest(input.identityReference),
      note: input.note.trim(),
    },
    requestedAt,
    dueAt,
    extendedDays: 0,
    duplicateOf: duplicate?.code,
    affectedSystemIds: [...input.affectedSystemIds],
    systemFulfillments: input.affectedSystemIds.map((systemId) => newFulfillment(systemId)),
    credentialLedger: [],
    tasks: buildWorkflowSteps({
      requestId,
      type: input.type,
      systemIds: input.affectedSystemIds,
      requestedAt,
      dueAt,
      initialStatus: 'identity-review',
      systems: draft.systems,
    }),
    evidence: [],
    conflicts: [],
    resultSummary: '',
    closureReason: '',
    audit: [],
  }
  if (identityInsufficient) {
    request.conflicts.push('身份材料不足：需要补充可核验的身份或授权关系证明。')
    const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
    if (identityTask) {
      identityTask.status = 'blocked'
      identityTask.exceptionReason = '身份材料不足，等待复核。'
    }
  }
  if (duplicate) {
    request.conflicts.push(`疑似重复请求：与 ${duplicate.code} 的请求人和请求类型相同。`)
  }
  draft.requests.unshift(request)
  appendAudit(
    draft,
    request,
    '登记隐私请求',
    operator,
    `按 ${responseDays[input.region]} 日模板登记，涉及 ${input.affectedSystemIds.length} 个系统。`,
  )
  draft.revision += 1
  return draft
}

export function saveRequest(
  state: WorkspaceState,
  requestId: string,
  patch: Partial<PrivacyRequest>,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      Object.assign(request, patch)
      request.audit = request.audit
      syncFulfillments(request)
      request.status = deriveStatus(request)
    },
    { action: '更新请求信息', operator, detail: '更新申请人、地区、请求类型或涉及系统。' },
  )
}

export function verifyIdentity(
  state: WorkspaceState,
  requestId: string,
  status: 'verified' | 'insufficient',
  note: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      request.identity.status = status
      request.identity.note = note
      request.identity.reviewedAt = now()
      const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
      if (status === 'verified') {
        if (identityTask) {
          identityTask.status = 'completed'
          identityTask.completedAt = now()
          identityTask.exceptionReason = ''
        }
        request.conflicts = request.conflicts.filter(
          (conflict) => !conflict.startsWith('身份材料不足'),
        )
        const nextTask = request.tasks.find((task) => task.status === 'pending')
        if (nextTask) nextTask.status = 'active'
        request.status = deriveStatus(request)
      } else {
        if (identityTask) {
          identityTask.status = 'blocked'
          identityTask.exceptionReason = note
        }
        request.status = 'review-required'
        if (!request.conflicts.some((conflict) => conflict.startsWith('身份材料不足'))) {
          request.conflicts.push(`身份材料不足：${note}`)
        }
      }
    },
    {
      action: status === 'verified' ? '身份核验通过' : '身份材料退回',
      operator,
      detail: note,
    },
  )
}

export function assignTask(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  assignee: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      task.assignee = assignee
    },
    { action: '分派履约任务', operator, detail: `任务 ${taskId} 分派给 ${assignee}。` },
  )
}

export function taskAction(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  action: 'start' | 'complete' | 'block',
  note: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      if (request.identity.status !== 'verified') {
        throw new Error('身份未核验通过，不能推进履约任务')
      }
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      if (action === 'start') {
        task.status = 'active'
        task.exceptionReason = ''
      } else if (action === 'complete') {
        task.status = 'completed'
        task.completedAt = now()
        task.exceptionReason = ''
        const nextTask = request.tasks.find((item) => item.status === 'pending')
        if (nextTask) nextTask.status = 'active'
      } else {
        task.status = 'blocked'
        task.exceptionReason = note
        request.status = 'review-required'
        request.conflicts.push(`任务阻塞：${task.name}，${note}`)
      }
      const executableTasks = request.tasks.filter((item) => !item.id.endsWith('-close'))
      if (action === 'block') {
        request.status = 'review-required'
      } else if (executableTasks.every((item) => item.status === 'completed')) {
        request.status = deriveStatus(request)
      } else {
        request.status = request.status === 'extended' ? 'extended' : 'processing'
      }
    },
    {
      action:
        action === 'start' ? '开始履约任务' : action === 'complete' ? '完成履约任务' : '阻断履约任务',
      operator,
      detail: note || `${taskId} 状态更新为 ${action}。`,
    },
  )
}

export function addEvidence(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  name: string,
  evidenceType: 'execution-log' | 'screenshot' | 'signed-record' | 'system-response',
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      request.evidence.push({
        id: id('evidence'),
        stepId: taskId,
        name,
        evidenceType,
        digest: digest(`${name}-${now()}`),
        uploadedBy: operator,
        uploadedAt: now(),
        protected: true,
      })
    },
    {
      action: '上传执行证据',
      operator,
      detail: `${name} 已按受保护附件登记，保存摘要而非明文材料。`,
    },
  )
}

export function addConflict(
  state: WorkspaceState,
  requestId: string,
  conflict: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      request.conflicts.push(conflict)
      request.status = 'review-required'
    },
    { action: '标记冲突或例外', operator, detail: conflict },
  )
}

export function resolveConflict(
  state: WorkspaceState,
  requestId: string,
  conflictIndex: number,
  resolution: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const conflict = request.conflicts[conflictIndex]
      if (!conflict) throw new Error('冲突项不存在')
      request.conflicts.splice(conflictIndex, 1)
      request.status = deriveStatus(request)
    },
    { action: '复核处理冲突', operator, detail: resolution },
  )
}

export function extendRequest(
  state: WorkspaceState,
  requestId: string,
  days: number,
  reason: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const base = new Date(request.dueAt) > new Date() ? new Date(request.dueAt) : new Date()
      request.dueAt = addDays(base, days).toISOString()
      request.extendedDays += days
      request.status = 'extended'
    },
    { action: '延期请求处理', operator, detail: `延期 ${days} 天：${reason}` },
  )
}

export function closeRequest(
  state: WorkspaceState,
  requestId: string,
  resultSummary: string,
  closureReason: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      if (request.identity.status !== 'verified') {
        throw new Error('身份核验尚未通过，不能关闭请求')
      }
      const requiredTasks = request.tasks.filter((task) => !task.id.endsWith('-close'))
      if (requiredTasks.some((task) => task.status !== 'completed')) {
        throw new Error('仍有未完成任务，不能关闭请求')
      }
      if (request.conflicts.length) {
        throw new Error('仍有未解决冲突，不能关闭请求')
      }
      syncFulfillments(request)
      if (!allSystemsConfirmed(request)) {
        const missing = request.systemFulfillments
          .filter((entry) => entry.status !== 'confirmed')
          .map((entry) => entry.systemId)
        throw new Error(`仍有系统缺少最新成功凭证（${missing.join('、')}），不能关闭请求`)
      }
      if (new Date(request.dueAt) > new Date() && !closureReason.trim()) {
        throw new Error('截止时间前关闭必须填写提前关闭理由')
      }
      request.resultSummary = resultSummary
      request.closureReason = closureReason
      request.status = 'completed'
      const closeTask = request.tasks.find((task) => task.id.endsWith('-close'))
      if (closeTask) {
        closeTask.status = 'completed'
        closeTask.completedAt = now()
      }
    },
    {
      action: '完成并关闭请求',
      operator,
      detail: closureReason ? `提前关闭理由：${closureReason}` : '截止时间后完成关闭。',
    },
  )
}

export function addComment(
  state: WorkspaceState,
  requestId: string,
  content: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  draft.comments.unshift({
    id: id('comment'),
    requestId,
    author: operator,
    content,
    createdAt: now(),
  })
  appendAudit(draft, request, '提交处理意见', operator, content)
  draft.revision += 1
  return draft
}

export interface CredentialInput {
  systemId: string
  batchSeq: number
  batchLabel: string
  credentialRef: string
  outcome: 'success' | 'failure'
  failureNote: string
  receivedFrom: string
}

/**
 * 接收某系统的凭证或失败通知。
 * - 同一凭证重复送达只认第一次：重复凭证记入台账并忽略，不改变系统状态。
 * - 旧批次迟到可查看：旧批次接收记入台账并忽略，当前批次不回退。
 * - 已确认系统不退回待处理：成功后的失败通知保留说明，但确认保持有效。
 */
export function recordCredential(
  state: WorkspaceState,
  requestId: string,
  input: CredentialInput,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  if (request.status === 'completed' || request.status === 'rejected') {
    throw new Error('请求已关闭，不再接收系统凭证')
  }
  if (!request.affectedSystemIds.includes(input.systemId)) {
    throw new Error('该系统不在请求的受影响系统范围内')
  }
  syncFulfillments(request)
  const fulfillment = request.systemFulfillments.find((item) => item.systemId === input.systemId)
  if (!fulfillment) throw new Error('系统履约记录不存在')
  const system = draft.systems.find((item) => item.id === input.systemId)
  const systemName = system?.name ?? input.systemId

  const receivedAt = now()
  const maskedRef = maskCredential(input.credentialRef)
  const credentialDigest = digest(input.credentialRef)

  // 同一凭证重复送来：只认第一次，重复项仅留痕
  const sameCredential = request.credentialLedger.find(
    (receipt) =>
      receipt.systemId === input.systemId && receipt.credentialDigest === credentialDigest,
  )
  if (sameCredential) {
    const reason = `与首次接收记录 ${sameCredential.id} 的凭证相同，重复送达只认第一次。`
    request.credentialLedger.unshift({
      id: id('receipt'),
      systemId: input.systemId,
      batchSeq: input.batchSeq,
      batchLabel: input.batchLabel,
      credentialRef: maskedRef,
      credentialDigest,
      outcome: 'ignored-duplicate',
      failureNote: '',
      receivedAt,
      receivedFrom: input.receivedFrom,
      ignoredReason: reason,
    })
    appendAudit(
      draft,
      request,
      '忽略重复系统凭证',
      operator,
      `${systemName} 批次 ${input.batchLabel} 凭证重复送达，已忽略并保留首次接收结果。`,
    )
    draft.revision += 1
    return draft
  }

  // 旧批次迟到：可查看但不影响当前批次
  if (input.batchSeq < fulfillment.currentBatchSeq) {
    const reason = `当前履约批次为第 ${fulfillment.currentBatchSeq} 批，第 ${input.batchSeq} 批属旧批次迟到，仅留痕查看。`
    request.credentialLedger.unshift({
      id: id('receipt'),
      systemId: input.systemId,
      batchSeq: input.batchSeq,
      batchLabel: input.batchLabel,
      credentialRef: maskedRef,
      credentialDigest,
      outcome: 'ignored-stale-batch',
      failureNote: '',
      receivedAt,
      receivedFrom: input.receivedFrom,
      ignoredReason: reason,
    })
    appendAudit(
      draft,
      request,
      '忽略旧批次迟到凭证',
      operator,
      `${systemName} 第 ${input.batchSeq} 批凭证晚于当前第 ${fulfillment.currentBatchSeq} 批到达，已留痕忽略。`,
    )
    draft.revision += 1
    return draft
  }

  fulfillment.attempts += 1
  if (input.outcome === 'success') {
    fulfillment.currentBatchSeq = Math.max(fulfillment.currentBatchSeq, input.batchSeq)
    fulfillment.status = 'confirmed'
    fulfillment.lastSuccess = {
      credentialRef: maskedRef,
      credentialDigest,
      batchSeq: input.batchSeq,
      receivedAt,
    }
    fulfillment.lastFailureNote = ''
    request.credentialLedger.unshift({
      id: id('receipt'),
      systemId: input.systemId,
      batchSeq: input.batchSeq,
      batchLabel: input.batchLabel,
      credentialRef: maskedRef,
      credentialDigest,
      outcome: 'accepted-success',
      failureNote: '',
      receivedAt,
      receivedFrom: input.receivedFrom,
      ignoredReason: '',
    })
    appendAudit(
      draft,
      request,
      '接收系统成功凭证',
      operator,
      `${systemName} 批次 ${input.batchLabel} 成功凭证已确认（${maskedRef}），第 ${fulfillment.attempts} 次接收。`,
    )
  } else {
    request.credentialLedger.unshift({
      id: id('receipt'),
      systemId: input.systemId,
      batchSeq: input.batchSeq,
      batchLabel: input.batchLabel,
      credentialRef: maskedRef,
      credentialDigest,
      outcome: 'accepted-failure',
      failureNote: input.failureNote,
      receivedAt,
      receivedFrom: input.receivedFrom,
      ignoredReason: '',
    })
    // 已确认系统不退回待处理：保留确认，仅记录失败说明
    if (fulfillment.status === 'confirmed') {
      fulfillment.lastFailureNote = input.failureNote
      fulfillment.lastFailureAt = receivedAt
      appendAudit(
        draft,
        request,
        '记录已确认系统失败通知',
        operator,
        `${systemName} 在已确认后返回失败说明：${input.failureNote}；确认保持有效，不退回待处理。`,
      )
    } else {
      fulfillment.currentBatchSeq = Math.max(fulfillment.currentBatchSeq, input.batchSeq)
      fulfillment.status = 'failed'
      fulfillment.lastFailureNote = input.failureNote
      fulfillment.lastFailureAt = receivedAt
      appendAudit(
        draft,
        request,
        '接收系统失败通知',
        operator,
        `${systemName} 批次 ${input.batchLabel} 处理失败：${input.failureNote}；需按原系统重试。`,
      )
    }
  }

  request.status = deriveStatus(request)
  draft.revision += 1
  return draft
}

/** 系统失败后按原系统重试：只补未成功系统，并开启新的履约批次。 */
export function retrySystem(
  state: WorkspaceState,
  requestId: string,
  systemId: string,
  note: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  if (request.status === 'completed' || request.status === 'rejected') {
    throw new Error('请求已关闭，不能再发起重试')
  }
  if (!request.affectedSystemIds.includes(systemId)) {
    throw new Error('该系统不在请求的受影响系统范围内')
  }
  syncFulfillments(request)
  const fulfillment = request.systemFulfillments.find((item) => item.systemId === systemId)
  if (!fulfillment) throw new Error('系统履约记录不存在')
  if (fulfillment.status !== 'failed') {
    throw new Error('只有存在失败说明的未成功系统才需要重试')
  }
  const system = draft.systems.find((item) => item.id === systemId)
  const systemName = system?.name ?? systemId

  fulfillment.currentBatchSeq += 1
  fulfillment.status = 'awaiting'
  fulfillment.retryCount += 1

  appendAudit(
    draft,
    request,
    '按原系统发起重试',
    operator,
    `${systemName} 第 ${fulfillment.retryCount} 次重试，已开启第 ${fulfillment.currentBatchSeq} 批；仅补该未成功系统，其他系统结果不动。${note}`,
  )
  request.status = request.status === 'extended' ? 'extended' : 'processing'
  draft.revision += 1
  return draft
}

export function recordExport(
  state: WorkspaceState,
  scope: string,
  count: number,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  draft.audit.unshift({
    id: id('audit'),
    action: '导出处理包',
    operator,
    detail: `导出范围：${scope}，包含 ${count} 条请求。`,
    createdAt: now(),
  })
  draft.revision += 1
  return draft
}
