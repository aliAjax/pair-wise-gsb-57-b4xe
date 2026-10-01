import type {
  CredentialReceipt,
  FulfillmentDiscrepancy,
  PrivacyRequest,
  SystemFulfillment,
} from '@/types/domain'

const now = () => new Date().toISOString()
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

const stamp = (value: string) => new Date(value).toISOString()

export function credentialDigest(ref: string, batch: string): string {
  const raw = `${ref}|${batch}`
  let hash = 5381
  for (let index = 0; index < raw.length; index += 1) {
    hash = (hash * 33) ^ raw.charCodeAt(index)
  }
  return `CRED-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

// 同一系统内：相同引用 + 相同批次视为同一凭证（重复送达只认第一次）
export function credentialKey(ref: string, batch: string): string {
  return `${batch}::${ref.trim()}`
}

// 忽略原因（导出包与详情页都按这些文案还原每次接收与忽略）
export const ignoreReasons = {
  duplicate: (firstAt: string) =>
    `同一凭证重复送达，仅以首次接收（${stamp(firstAt)}）为准，本次忽略不改状态。`,
  staleBatch: (currentSeq: number) =>
    `旧批次迟到（序号低于当前批次 ${currentSeq}），仅留档查看，不覆盖当前处理结果。`,
  confirmed: (confirmedAt: string) =>
    `系统已确认（确认时间 ${stamp(confirmedAt)}），迟到凭证仅留档，不退回待处理。`,
}

export function createSystemFulfillment(systemId: string): SystemFulfillment {
  return {
    systemId,
    state: 'pending',
    batchSeq: 1,
    attempts: 1,
    lastFailureReason: '',
    receipts: [],
    retries: [],
  }
}

export function getFulfillment(
  request: PrivacyRequest,
  systemId: string,
): SystemFulfillment | undefined {
  return request.systemFulfillments.find((item) => item.systemId === systemId)
}

function requireFulfillment(request: PrivacyRequest, systemId: string): SystemFulfillment {
  if (!request.affectedSystemIds.includes(systemId)) {
    throw new Error('该系统不在请求的受影响系统范围内')
  }
  const fulfillment = getFulfillment(request, systemId)
  if (!fulfillment) throw new Error('系统履约台账尚未初始化')
  return fulfillment
}

export interface ReceiveCredentialInput {
  systemId: string
  outcome: 'success' | 'failure'
  batch: string
  batchSeq: number
  credentialRef: string
  detail: string
  operator: string
}

export interface ReceiveCredentialResult {
  accepted: boolean
  receipt: CredentialReceipt
}

/**
 * 记录一次系统凭证送达。台账只追加：
 * - 同一凭证重复送达 → 第二次起标记 ignored，只认第一次
 * - 旧批次迟到 → ignored 留档，已确认系统也不退回待处理
 * - 成功凭证更新最近成功凭证；失败回报保留失败说明但不清除成功凭证
 */
export function receiveCredential(
  request: PrivacyRequest,
  input: ReceiveCredentialInput,
): ReceiveCredentialResult {
  const fulfillment = requireFulfillment(request, input.systemId)
  const key = credentialKey(input.credentialRef, input.batch)
  const receivedAt = now()
  const earlier = fulfillment.receipts.find((receipt) => receipt.credentialKey === key)

  let status: CredentialReceipt['status'] = 'accepted'
  const reasonParts: string[] = []
  if (earlier) {
    status = 'ignored'
    reasonParts.push(ignoreReasons.duplicate(earlier.receivedAt))
  }
  if (input.batchSeq < fulfillment.batchSeq) {
    status = 'ignored'
    reasonParts.push(ignoreReasons.staleBatch(fulfillment.batchSeq))
  }
  if (fulfillment.state === 'confirmed' && fulfillment.confirmedAt) {
    status = 'ignored'
    reasonParts.push(ignoreReasons.confirmed(fulfillment.confirmedAt))
  }

  const receipt: CredentialReceipt = {
    id: newId('receipt'),
    systemId: input.systemId,
    credentialKey: key,
    batch: input.batch,
    batchSeq: input.batchSeq,
    outcome: input.outcome,
    status,
    reason: reasonParts.join(' '),
    credentialRef: input.credentialRef.trim(),
    credentialDigest: credentialDigest(input.credentialRef, input.batch),
    detail: input.detail.trim(),
    receivedAt,
    receivedBy: input.operator,
  }
  fulfillment.receipts.push(receipt)

  if (status === 'accepted') {
    if (input.outcome === 'success') {
      fulfillment.state = 'confirmed' === fulfillment.state ? 'confirmed' : 'succeeded'
      fulfillment.lastSuccessReceiptId = receipt.id
    } else {
      // 已确认系统不会被迟到/重复凭证回退；非确认系统收到失败即进入失败
      if (fulfillment.state !== 'confirmed') {
        fulfillment.state = 'failed'
        fulfillment.lastFailureAt = receivedAt
        fulfillment.lastFailureReason = input.detail.trim()
      }
    }
  }

  return { accepted: status === 'accepted', receipt }
}

/**
 * 按原系统重试：只针对仍失败的系统。
 * 保留最近成功凭证与历次失败说明，当前批次序号与重试轮次递增。
 */
export function retryFailedSystems(
  request: PrivacyRequest,
  options: { systemId?: string; reason: string; operator: string },
): SystemFulfillment[] {
  const targets = request.systemFulfillments.filter((fulfillment) => {
    if (fulfillment.state !== 'failed') return false
    if (options.systemId) return fulfillment.systemId === options.systemId
    return request.affectedSystemIds.includes(fulfillment.systemId)
  })
  if (options.systemId && !targets.length) {
    throw new Error('该系统当前不在失败状态，无需重试')
  }
  if (!targets.length) throw new Error('没有需要重试的失败系统')

  const retriedAt = now()
  for (const fulfillment of targets) {
    fulfillment.batchSeq += 1
    fulfillment.attempts += 1
    fulfillment.state = 'pending'
    fulfillment.retries.push({
      round: fulfillment.attempts,
      batch: `批次 ${fulfillment.batchSeq}`,
      reason: options.reason.trim(),
      retriedAt,
      retriedBy: options.operator,
    })
  }
  return targets
}

export function confirmSystem(
  request: PrivacyRequest,
  systemId: string,
  note: string,
  operator: string,
): SystemFulfillment {
  const fulfillment = requireFulfillment(request, systemId)
  if (!fulfillment.lastSuccessReceiptId) {
    throw new Error('该系统尚无成功凭证，不能确认')
  }
  const open = request.fulfillmentDiscrepancies.some(
    (item) => item.systemId === systemId && item.status === 'open',
  )
  if (open) throw new Error('该系统仍有未处理的凭证差异，不能确认')
  if (fulfillment.state === 'confirmed') return fulfillment
  fulfillment.state = 'confirmed'
  fulfillment.confirmedAt = now()
  fulfillment.confirmedBy = operator
  return fulfillment
}

export function raiseDiscrepancy(
  request: PrivacyRequest,
  input: {
    systemId: string
    kind: FulfillmentDiscrepancy['kind']
    description: string
    operator: string
  },
): FulfillmentDiscrepancy {
  requireFulfillment(request, input.systemId)
  const discrepancy: FulfillmentDiscrepancy = {
    id: newId('discrepancy'),
    systemId: input.systemId,
    kind: input.kind,
    description: input.description.trim(),
    raisedAt: now(),
    raisedBy: input.operator,
    status: 'open',
    resolution: '',
  }
  request.fulfillmentDiscrepancies.unshift(discrepancy)
  return discrepancy
}

export function resolveDiscrepancy(
  request: PrivacyRequest,
  discrepancyId: string,
  resolution: string,
  operator: string,
): FulfillmentDiscrepancy {
  const discrepancy = request.fulfillmentDiscrepancies.find((item) => item.id === discrepancyId)
  if (!discrepancy) throw new Error('凭证差异项不存在')
  if (discrepancy.status === 'resolved') throw new Error('该凭证差异已处理完成')
  discrepancy.status = 'resolved'
  discrepancy.resolution = resolution.trim()
  discrepancy.resolvedAt = now()
  discrepancy.resolvedBy = operator
  return discrepancy
}

/**
 * 依据凭证台账重算请求状态：
 * - 存在未处理凭证差异 → 复核队列
 * - 所有受影响系统均有最近成功凭证 → 待关闭（已确认系统不退回）
 * - 否则 → 履约处理中
 */
export function refreshFulfillmentStatus(request: PrivacyRequest): void {
  const hasOpenDiscrepancy = request.fulfillmentDiscrepancies.some(
    (item) => item.status === 'open',
  )
  const fulfillments = request.affectedSystemIds.map(
    (systemId) => requireFulfillment(request, systemId),
  )
  const allSucceeded = fulfillments.every((fulfillment) => Boolean(fulfillment.lastSuccessReceiptId))
  if (hasOpenDiscrepancy || request.conflicts.length > 0) {
    request.status = 'review-required'
  } else if (allSucceeded) {
    request.status = 'pending-close'
  } else {
    request.status = 'processing'
  }
}

/** 关闭闸门：所有受影响系统有最新成功凭证，且凭证差异已全部处理 */
export function closureBlockers(request: PrivacyRequest): string[] {
  const blockers: string[] = []
  for (const systemId of request.affectedSystemIds) {
    const fulfillment = getFulfillment(request, systemId)
    if (!fulfillment) {
      blockers.push('部分受影响系统缺少履约凭证台账')
      continue
    }
    if (!fulfillment.lastSuccessReceiptId) {
      blockers.push('仍有受影响系统未取得最新成功凭证，不能关闭')
    }
  }
  if (request.fulfillmentDiscrepancies.some((item) => item.status === 'open')) {
    blockers.push('仍有凭证差异未处理完成，不能关闭')
  }
  return [...new Set(blockers)]
}

/** 关闭时把仅有成功凭证但未逐系统确认的系统一并确认，之后凭证只留档不回退 */
export function confirmRemainingOnClose(
  request: PrivacyRequest,
  operator: string,
  closedAt = now(),
): void {
  for (const systemId of request.affectedSystemIds) {
    const fulfillment = getFulfillment(request, systemId)
    if (fulfillment && fulfillment.state !== 'confirmed' && fulfillment.lastSuccessReceiptId) {
      fulfillment.state = 'confirmed'
      fulfillment.confirmedAt = closedAt
      fulfillment.confirmedBy = operator
    }
  }
}
