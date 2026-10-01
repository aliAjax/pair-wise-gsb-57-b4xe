'use client'

import { useState } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Collapse,
  Flex,
  FormControl,
  FormLabel,
  Heading,
  HStack,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Select,
  SimpleGrid,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Textarea,
  Th,
  Thead,
  Tr,
  VStack,
  useDisclosure,
  useToast,
} from '@chakra-ui/react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  History,
  RotateCw,
  ShieldQuestion,
} from 'lucide-react'
import type {
  CredentialReceipt,
  DataSystem,
  FulfillmentDiscrepancy,
  PrivacyRequest,
  SystemFulfillment,
} from '@/types/domain'
import {
  credentialOutcomeLabels,
  discrepancyKindLabels,
  fulfillmentStateLabels,
} from '@/lib/schemas'
import { closureBlockers } from '@/services/credentials'
import {
  useConfirmSystemMutation,
  useRaiseDiscrepancyMutation,
  useReceiveCredentialMutation,
  useResolveDiscrepancyMutation,
  useRetryFulfillmentMutation,
} from '@/lib/hooks'

const stateColor: Record<SystemFulfillment['state'], string> = {
  pending: 'gray',
  succeeded: 'green',
  failed: 'red',
  confirmed: 'teal',
}

const receiptStatusColor: Record<CredentialReceipt['status'], string> = {
  accepted: 'green',
  ignored: 'orange',
}

const emptyCredentialForm = {
  systemId: '',
  outcome: 'success' as 'success' | 'failure',
  batch: '批次 1',
  batchSeq: 1,
  credentialRef: '',
  detail: '',
}

export function CredentialFulfillmentPanel({
  request,
  systems,
}: {
  request: PrivacyRequest
  systems: DataSystem[]
}) {
  const toast = useToast()
  const receiveCredential = useReceiveCredentialMutation()
  const retryFulfillment = useRetryFulfillmentMutation()
  const confirmSystem = useConfirmSystemMutation()
  const raiseDiscrepancy = useRaiseDiscrepancyMutation()
  const resolveDiscrepancy = useResolveDiscrepancyMutation()

  const {
    isOpen: credentialOpen,
    onOpen: onCredentialOpen,
    onClose: onCredentialClose,
  } = useDisclosure()
  const {
    isOpen: retryOpen,
    onOpen: onRetryOpen,
    onClose: onRetryClose,
  } = useDisclosure()
  const {
    isOpen: discrepancyOpen,
    onOpen: onDiscrepancyOpen,
    onClose: onDiscrepancyClose,
  } = useDisclosure()

  const [credentialForm, setCredentialForm] = useState(emptyCredentialForm)
  const [retrySystemId, setRetrySystemId] = useState<string | undefined>(undefined)
  const [retryReason, setRetryReason] = useState('')
  const [confirmSystemId, setConfirmSystemId] = useState<string | undefined>(undefined)
  const [confirmNote, setConfirmNote] = useState('')
  const [discrepancyForm, setDiscrepancyForm] = useState({
    systemId: '',
    kind: 'content-mismatch' as FulfillmentDiscrepancy['kind'],
    description: '',
  })
  const [resolvingId, setResolvingId] = useState<string | undefined>(undefined)
  const [resolution, setResolution] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const systemById = new Map(systems.map((system) => [system.id, system]))
  const nameOf = (systemId: string) => systemById.get(systemId)?.name ?? systemId
  const closed = request.status === 'completed'
  const failedSystems = request.systemFulfillments.filter((item) => item.state === 'failed')
  const succeededSystems = request.systemFulfillments.filter(
    (item) => item.lastSuccessReceiptId,
  )
  const openDiscrepancies = request.fulfillmentDiscrepancies.filter(
    (item) => item.status === 'open',
  )
  const blockers = closureBlockers(request)
  const totalReceipts = request.systemFulfillments.reduce(
    (total, item) => total + item.receipts.length,
    0,
  )
  const ignoredReceipts = request.systemFulfillments.reduce(
    (total, item) => total + item.receipts.filter((receipt) => receipt.status === 'ignored').length,
    0,
  )
  const allReceipts = request.systemFulfillments
    .flatMap((fulfillment) => fulfillment.receipts)
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))

  function openCredential(systemId?: string) {
    const first = systemId ?? request.affectedSystemIds[0] ?? ''
    const fulfillment = request.systemFulfillments.find((item) => item.systemId === first)
    setCredentialForm({
      systemId: first,
      outcome: 'success',
      batch: `批次 ${fulfillment?.batchSeq ?? 1}`,
      batchSeq: fulfillment?.batchSeq ?? 1,
      credentialRef: '',
      detail: '',
    })
    onCredentialOpen()
  }

  function syncCredentialBatch(systemId: string) {
    const fulfillment = request.systemFulfillments.find((item) => item.systemId === systemId)
    const seq = fulfillment?.batchSeq ?? 1
    setCredentialForm((form) => ({ ...form, systemId, batch: `批次 ${seq}`, batchSeq: seq }))
  }

  async function submitCredential() {
    if (!credentialForm.credentialRef.trim()) {
      toast({ title: '请填写凭证引用或回执编号', status: 'warning' })
      return
    }
    try {
      await receiveCredential.mutateAsync({
        requestId: request.id,
        systemId: credentialForm.systemId,
        outcome: credentialForm.outcome,
        batch: credentialForm.batch.trim(),
        batchSeq: credentialForm.batchSeq,
        credentialRef: credentialForm.credentialRef.trim(),
        detail: credentialForm.detail.trim(),
        operator: systemById.get(credentialForm.systemId)?.owner ?? '数据管理员',
      })
      toast({
        title: '凭证送达已登记',
        description: '重复或迟到的凭证已按规则标记为忽略并保留原因。',
        status: 'success',
      })
      setCredentialForm(emptyCredentialForm)
      onCredentialClose()
    } catch (error) {
      toast({
        title: '凭证登记失败',
        description: error instanceof Error ? error.message : '请检查系统与批次信息',
        status: 'error',
      })
    }
  }

  function openRetry(systemId?: string) {
    setRetrySystemId(systemId)
    setRetryReason('')
    onRetryOpen()
  }

  async function submitRetry() {
    if (retryReason.trim().length < 2) {
      toast({ title: '请填写重试原因', status: 'warning' })
      return
    }
    try {
      await retryFulfillment.mutateAsync({
        requestId: request.id,
        systemId: retrySystemId,
        reason: retryReason.trim(),
        operator: '隐私运营',
      })
      toast({ title: '已按原系统重试未成功系统', status: 'success' })
      onRetryClose()
    } catch (error) {
      toast({
        title: '重试未发起',
        description: error instanceof Error ? error.message : '仅失败系统可重试',
        status: 'error',
      })
    }
  }

  function openConfirm(systemId: string) {
    setConfirmSystemId(systemId)
    setConfirmNote('')
  }

  async function submitConfirm() {
    if (!confirmSystemId) return
    try {
      await confirmSystem.mutateAsync({
        requestId: request.id,
        systemId: confirmSystemId,
        note: confirmNote.trim(),
        operator: '隐私负责人',
      })
      toast({ title: '系统结果已确认，后续凭证仅留档', status: 'success' })
      setConfirmSystemId(undefined)
    } catch (error) {
      toast({
        title: '确认失败',
        description: error instanceof Error ? error.message : '请先处理差异',
        status: 'error',
      })
    }
  }

  function openDiscrepancy(systemId?: string) {
    setDiscrepancyForm({
      systemId: systemId ?? request.affectedSystemIds[0] ?? '',
      kind: 'content-mismatch',
      description: '',
    })
    onDiscrepancyOpen()
  }

  async function submitDiscrepancy() {
    if (discrepancyForm.description.trim().length < 4) {
      toast({ title: '请填写差异说明', status: 'warning' })
      return
    }
    try {
      await raiseDiscrepancy.mutateAsync({
        requestId: request.id,
        systemId: discrepancyForm.systemId,
        kind: discrepancyForm.kind,
        description: discrepancyForm.description.trim(),
        operator: '隐私运营',
      })
      toast({ title: '凭证差异已提出并进入复核', status: 'success' })
      onDiscrepancyClose()
    } catch (error) {
      toast({
        title: '差异登记失败',
        description: error instanceof Error ? error.message : '请检查输入',
        status: 'error',
      })
    }
  }

  async function submitResolution() {
    if (!resolvingId || resolution.trim().length < 4) {
      toast({ title: '请填写差异处理结论', status: 'warning' })
      return
    }
    try {
      await resolveDiscrepancy.mutateAsync({
        requestId: request.id,
        discrepancyId: resolvingId,
        resolution: resolution.trim(),
        operator: '隐私负责人',
      })
      toast({ title: '凭证差异处理结论已记录', status: 'success' })
      setResolvingId(undefined)
      setResolution('')
    } catch (error) {
      toast({
        title: '处理失败',
        description: error instanceof Error ? error.message : '请重试',
        status: 'error',
      })
    }
  }

  function latestReceipt(fulfillment: SystemFulfillment): CredentialReceipt | undefined {
    return [...fulfillment.receipts].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0]
  }

  return (
    <Box className="panel">
      <Flex className="panel-title">
        <HStack>
          <History size={18} color="#237b78" />
          <Heading size="sm">跨系统履约凭证台账</Heading>
        </HStack>
        <HStack>
          <Badge colorScheme="teal">
            已成功 {succeededSystems.length}/{request.affectedSystemIds.length}
          </Badge>
          <Badge colorScheme={failedSystems.length ? 'red' : 'green'}>
            失败 {failedSystems.length}
          </Badge>
          <Badge colorScheme={ignoredReceipts ? 'orange' : 'gray'}>
            忽略留档 {ignoredReceipts}/{totalReceipts}
          </Badge>
        </HStack>
      </Flex>

      {blockers.length ? (
        <Alert status="error" mb="4" borderRadius="5px">
          关闭条件未满足：{blockers.join('；')}
        </Alert>
      ) : (
        <Alert status="success" mb="4" borderRadius="5px">
          全部受影响系统均持有最新成功凭证，凭证差异已处理完成，可以进入关闭确认。
        </Alert>
      )}

      <HStack mb="4" wrap="wrap">
        <Button
          size="sm"
          colorScheme="brand"
          isDisabled={closed}
          onClick={() => openCredential()}
        >
          登记系统凭证送达
        </Button>
        <Button
          size="sm"
          colorScheme="orange"
          variant="outline"
          leftIcon={<RotateCw size={14} />}
          isDisabled={closed || !failedSystems.length}
          onClick={() => openRetry()}
        >
          重试全部失败系统（{failedSystems.length}）
        </Button>
        <Button
          size="sm"
          variant="outline"
          leftIcon={<ShieldQuestion size={14} />}
          isDisabled={closed}
          onClick={() => openDiscrepancy()}
        >
          提出凭证差异
        </Button>
      </HStack>

      <SimpleGrid columns={{ base: 1, lg: 2 }} spacing="3">
        {request.systemFulfillments.map((fulfillment) => {
          const openForSystem = openDiscrepancies.filter(
            (item) => item.systemId === fulfillment.systemId,
          )
          const latest = latestReceipt(fulfillment)
          const successReceipt = fulfillment.receipts.find(
            (receipt) => receipt.id === fulfillment.lastSuccessReceiptId,
          )
          const isExpanded = expanded[fulfillment.systemId]
          return (
            <Box key={fulfillment.systemId} p="3" bg="gray.50" borderRadius="6px">
              <Flex justify="space-between" align="flex-start" gap="3">
                <Box>
                  <HStack>
                    <Text fontWeight="700">{nameOf(fulfillment.systemId)}</Text>
                    <Badge colorScheme={stateColor[fulfillment.state]}>
                      {fulfillmentStateLabels[fulfillment.state]}
                    </Badge>
                    {fulfillment.state === 'confirmed' ? (
                      <Badge colorScheme="teal" variant="subtle">
                        不退回待处理
                      </Badge>
                    ) : null}
                  </HStack>
                  <Text mt="1" color="gray.600" fontSize="xs">
                    当前批次 {fulfillment.batchSeq} · 重试轮次 {fulfillment.attempts} ·
                    台账 {fulfillment.receipts.length} 条
                  </Text>
                </Box>
                <HStack wrap="wrap" justify="flex-end">
                  <Button size="xs" variant="ghost" isDisabled={closed} onClick={() => openCredential(fulfillment.systemId)}>
                    送凭证
                  </Button>
                  {fulfillment.state === 'failed' ? (
                    <Button size="xs" variant="ghost" colorScheme="orange" isDisabled={closed} onClick={() => openRetry(fulfillment.systemId)}>
                      按原系统重试
                    </Button>
                  ) : null}
                  {fulfillment.state === 'succeeded' ? (
                    <Button size="xs" variant="ghost" colorScheme="teal" isDisabled={closed} onClick={() => openConfirm(fulfillment.systemId)}>
                      确认系统
                    </Button>
                  ) : null}
                  <Button size="xs" variant="ghost" isDisabled={closed} onClick={() => openDiscrepancy(fulfillment.systemId)}>
                    差异
                  </Button>
                </HStack>
              </Flex>

              <VStack align="stretch" mt="2" spacing="1">
                {successReceipt ? (
                  <Text fontSize="xs" color="green.700">
                    <CheckCircle2 size={12} style={{ display: 'inline', marginRight: 4 }} />
                    最近成功凭证：{successReceipt.credentialRef}（{successReceipt.batch}）·
                    {new Date(successReceipt.receivedAt).toLocaleString('zh-CN')}
                  </Text>
                ) : (
                  <Text fontSize="xs" color="gray.500">
                    尚无成功凭证。
                  </Text>
                )}
                {fulfillment.lastFailureReason ? (
                  <Text fontSize="xs" color="red.700">
                    失败说明：{fulfillment.lastFailureReason}
                    {fulfillment.lastFailureAt
                      ? `（${new Date(fulfillment.lastFailureAt).toLocaleString('zh-CN')}）`
                      : ''}
                  </Text>
                ) : null}
                {fulfillment.confirmedAt ? (
                  <Text fontSize="xs" color="teal.700">
                    由 {fulfillment.confirmedBy} 于{' '}
                    {new Date(fulfillment.confirmedAt).toLocaleString('zh-CN')} 确认。
                  </Text>
                ) : null}
                {openForSystem.map((item) => (
                  <Text key={item.id} fontSize="xs" color="orange.700">
                    待处理差异（{discrepancyKindLabels[item.kind]}）：{item.description}
                  </Text>
                ))}
                {latest && latest.status === 'ignored' ? (
                  <Text fontSize="xs" color="orange.700">
                    最近一次送达已忽略：{latest.reason}
                  </Text>
                ) : null}
              </VStack>

              <Button
                mt="2"
                size="xs"
                variant="link"
                leftIcon={isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                onClick={() =>
                  setExpanded((value) => ({ ...value, [fulfillment.systemId]: !isExpanded }))
                }
              >
                {isExpanded ? '收起接收台账' : `查看全部 ${fulfillment.receipts.length} 次接收/忽略`}
              </Button>
              <Collapse in={isExpanded} animateOpacity>
                <TableContainer mt="2">
                  <Table size="xs">
                    <Thead>
                      <Tr>
                        <Th>时间</Th>
                        <Th>批次</Th>
                        <Th>结果</Th>
                        <Th>处置</Th>
                        <Th>凭证引用/原因</Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {[...fulfillment.receipts]
                        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
                        .map((receipt) => (
                          <Tr key={receipt.id}>
                            <Td whiteSpace="nowrap">
                              {new Date(receipt.receivedAt).toLocaleString('zh-CN')}
                            </Td>
                            <Td>{receipt.batch}</Td>
                            <Td>{credentialOutcomeLabels[receipt.outcome]}</Td>
                            <Td>
                              <Badge colorScheme={receiptStatusColor[receipt.status]}>
                                {receipt.status === 'accepted' ? '接受' : '忽略'}
                              </Badge>
                            </Td>
                            <Td>
                              <Text className="mono" fontSize="xs">
                                {receipt.credentialRef} · {receipt.credentialDigest}
                              </Text>
                              {receipt.status === 'ignored' ? (
                                <Text mt="1" color="orange.700" fontSize="xs">
                                  {receipt.reason}
                                </Text>
                              ) : (
                                <Text mt="1" color="gray.600" fontSize="xs">
                                  {receipt.detail}
                                </Text>
                              )}
                            </Td>
                          </Tr>
                        ))}
                      {!fulfillment.receipts.length ? (
                        <Tr>
                          <Td colSpan={5}>
                            <Text color="gray.500" fontSize="xs">
                              尚无凭证送达记录。
                            </Text>
                          </Td>
                        </Tr>
                      ) : null}
                    </Tbody>
                  </Table>
                </TableContainer>
              </Collapse>
            </Box>
          )
        })}
      </SimpleGrid>

      <Box mt="5">
        <Flex className="panel-title">
          <Heading size="xs">凭证差异处理</Heading>
          <Badge colorScheme={openDiscrepancies.length ? 'red' : 'green'}>
            待处理 {openDiscrepancies.length}
          </Badge>
        </Flex>
        <TableContainer>
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>系统</Th>
                <Th>类型</Th>
                <Th>差异说明</Th>
                <Th>状态/处理结论</Th>
                <Th>操作</Th>
              </Tr>
            </Thead>
            <Tbody>
              {request.fulfillmentDiscrepancies.map((item) => (
                <Tr key={item.id}>
                  <Td>{nameOf(item.systemId)}</Td>
                  <Td>
                    <Badge>{discrepancyKindLabels[item.kind]}</Badge>
                  </Td>
                  <Td maxW="320px">
                    <Text fontSize="sm">{item.description}</Text>
                    <Text mt="1" color="gray.500" fontSize="xs">
                      {item.raisedBy} · {new Date(item.raisedAt).toLocaleString('zh-CN')}
                    </Text>
                  </Td>
                  <Td maxW="260px">
                    {item.status === 'open' ? (
                      <Badge colorScheme="red">待处理</Badge>
                    ) : (
                      <>
                        <Badge colorScheme="green">已处理</Badge>
                        <Text mt="1" color="gray.600" fontSize="xs">
                          {item.resolution}
                        </Text>
                        <Text color="gray.500" fontSize="xs">
                          {item.resolvedBy} ·{' '}
                          {item.resolvedAt
                            ? new Date(item.resolvedAt).toLocaleString('zh-CN')
                            : ''}
                        </Text>
                      </>
                    )}
                  </Td>
                  <Td>
                    {item.status === 'open' && !closed ? (
                      <Button
                        size="xs"
                        variant="outline"
                        colorScheme="red"
                        onClick={() => {
                          setResolvingId(item.id)
                          setResolution('')
                        }}
                      >
                        记录处理结论
                      </Button>
                    ) : null}
                  </Td>
                </Tr>
              ))}
              {!request.fulfillmentDiscrepancies.length ? (
                <Tr>
                  <Td colSpan={5}>
                    <Text color="gray.500" fontSize="sm">
                      暂无凭证差异。
                    </Text>
                  </Td>
                </Tr>
              ) : null}
            </Tbody>
          </Table>
        </TableContainer>
      </Box>

      <Box mt="5">
        <Flex className="panel-title">
          <Heading size="xs">全量凭证接收明细（按送达时间倒序）</Heading>
          <Badge>{allReceipts.length} 条</Badge>
        </Flex>
        <TableContainer>
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>时间</Th>
                <Th>系统</Th>
                <Th>批次</Th>
                <Th>结果</Th>
                <Th>处置</Th>
                <Th>凭证摘要</Th>
                <Th>说明 / 忽略原因</Th>
              </Tr>
            </Thead>
            <Tbody>
              {allReceipts.map((receipt) => (
                <Tr key={receipt.id}>
                  <Td whiteSpace="nowrap">
                    {new Date(receipt.receivedAt).toLocaleString('zh-CN')}
                  </Td>
                  <Td>{nameOf(receipt.systemId)}</Td>
                  <Td>{receipt.batch}</Td>
                  <Td>{credentialOutcomeLabels[receipt.outcome]}</Td>
                  <Td>
                    <Badge colorScheme={receiptStatusColor[receipt.status]}>
                      {receipt.status === 'accepted' ? '接受（首次）' : '忽略'}
                    </Badge>
                  </Td>
                  <Td>
                    <Text className="mono" fontSize="xs">
                      {receipt.credentialRef}
                    </Text>
                    <Text className="mono" color="gray.500" fontSize="xs">
                      {receipt.credentialDigest}
                    </Text>
                  </Td>
                  <Td maxW="360px">
                    <Text fontSize="xs" color={receipt.status === 'ignored' ? 'orange.700' : 'gray.600'}>
                      {receipt.status === 'ignored' ? receipt.reason : receipt.detail}
                    </Text>
                    <Text mt="1" color="gray.500" fontSize="xs">
                      {receipt.receivedBy}
                    </Text>
                  </Td>
                </Tr>
              ))}
              {!allReceipts.length ? (
                <Tr>
                  <Td colSpan={7}>
                    <Text color="gray.500" fontSize="sm">
                      各系统凭证送达后在此留痕，重复与迟到凭证的忽略原因可完整还原。
                    </Text>
                  </Td>
                </Tr>
              ) : null}
            </Tbody>
          </Table>
        </TableContainer>
      </Box>

      {/* 凭证送达 */}
      <Modal isOpen={credentialOpen} onClose={onCredentialClose} size="lg">
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>登记系统凭证送达</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Alert status="info" mb="4" borderRadius="5px">
              同一凭证重复送达只认第一次；旧批次迟到与已确认系统的补送仅留档忽略，可在台账查看原因。
            </Alert>
            <VStack align="stretch" spacing="4">
              <FormControl isRequired>
                <FormLabel>送达系统</FormLabel>
                <Select
                  value={credentialForm.systemId}
                  onChange={(event) => syncCredentialBatch(event.target.value)}
                >
                  {request.affectedSystemIds.map((systemId) => (
                    <option key={systemId} value={systemId}>
                      {nameOf(systemId)}
                    </option>
                  ))}
                </Select>
              </FormControl>
              <Flex gap="4">
                <FormControl isRequired>
                  <FormLabel>送达结果</FormLabel>
                  <Select
                    value={credentialForm.outcome}
                    onChange={(event) =>
                      setCredentialForm({
                        ...credentialForm,
                        outcome: event.target.value as 'success' | 'failure',
                      })
                    }
                  >
                    <option value="success">成功凭证</option>
                    <option value="failure">失败回报</option>
                  </Select>
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>批次序号（数字）</FormLabel>
                  <Input
                    type="number"
                    min={1}
                    value={credentialForm.batchSeq}
                    onChange={(event) =>
                      setCredentialForm({
                        ...credentialForm,
                        batchSeq: Number(event.target.value),
                        batch: `批次 ${event.target.value}`,
                      })
                    }
                  />
                </FormControl>
              </Flex>
              <FormControl isRequired>
                <FormLabel>批次标签</FormLabel>
                <Input
                  value={credentialForm.batch}
                  onChange={(event) =>
                    setCredentialForm({ ...credentialForm, batch: event.target.value })
                  }
                />
              </FormControl>
              <FormControl isRequired>
                <FormLabel>凭证引用 / 回执编号（脱敏标识）</FormLabel>
                <Input
                  value={credentialForm.credentialRef}
                  onChange={(event) =>
                    setCredentialForm({ ...credentialForm, credentialRef: event.target.value })
                  }
                  placeholder="例如 CRM-DELETE-RCP-1201"
                />
              </FormControl>
              <FormControl>
                <FormLabel>
                  {credentialForm.outcome === 'success' ? '凭证说明' : '失败原因说明'}
                </FormLabel>
                <Textarea
                  value={credentialForm.detail}
                  onChange={(event) =>
                    setCredentialForm({ ...credentialForm, detail: event.target.value })
                  }
                  placeholder={
                    credentialForm.outcome === 'success'
                      ? '说明凭证覆盖范围与处理结果'
                      : '失败说明会保留在系统台账，重试只补未成功系统'
                  }
                />
              </FormControl>
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={onCredentialClose}>
              取消
            </Button>
            <Button colorScheme="brand" isLoading={receiveCredential.isPending} onClick={submitCredential}>
              登记送达
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 重试 */}
      <Modal isOpen={retryOpen} onClose={onRetryClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>
            {retrySystemId ? `按原系统重试：${nameOf(retrySystemId)}` : '按原系统重试全部失败系统'}
          </ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Alert status="warning" mb="4" borderRadius="5px">
              仅对仍失败的系统按原系统重新发起；最近成功凭证与历次失败说明保留，请求从待关闭回到处理中。
            </Alert>
            <FormControl isRequired>
              <FormLabel>重试原因</FormLabel>
              <Textarea
                value={retryReason}
                onChange={(event) => setRetryReason(event.target.value)}
                placeholder="例如 修复字段映射后重新导出"
              />
            </FormControl>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={onRetryClose}>
              取消
            </Button>
            <Button colorScheme="orange" isLoading={retryFulfillment.isPending} onClick={submitRetry}>
              发起重试
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 凭证差异 */}
      <Modal isOpen={discrepancyOpen} onClose={onDiscrepancyClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>提出跨系统凭证差异</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack align="stretch" spacing="4">
              <FormControl isRequired>
                <FormLabel>关联系统</FormLabel>
                <Select
                  value={discrepancyForm.systemId}
                  onChange={(event) =>
                    setDiscrepancyForm({ ...discrepancyForm, systemId: event.target.value })
                  }
                >
                  {request.affectedSystemIds.map((systemId) => (
                    <option key={systemId} value={systemId}>
                      {nameOf(systemId)}
                    </option>
                  ))}
                </Select>
              </FormControl>
              <FormControl isRequired>
                <FormLabel>差异类型</FormLabel>
                <Select
                  value={discrepancyForm.kind}
                  onChange={(event) =>
                    setDiscrepancyForm({
                      ...discrepancyForm,
                      kind: event.target.value as FulfillmentDiscrepancy['kind'],
                    })
                  }
                >
                  {Object.entries(discrepancyKindLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </FormControl>
              <FormControl isRequired>
                <FormLabel>差异说明</FormLabel>
                <Textarea
                  value={discrepancyForm.description}
                  onChange={(event) =>
                    setDiscrepancyForm({ ...discrepancyForm, description: event.target.value })
                  }
                  placeholder="说明凭证之间或与预期处理结果的具体差异"
                />
              </FormControl>
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={onDiscrepancyClose}>
              取消
            </Button>
            <Button colorScheme="brand" isLoading={raiseDiscrepancy.isPending} onClick={submitDiscrepancy}>
              提交差异复核
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 差异处理结论 */}
      <Modal
        isOpen={Boolean(resolvingId)}
        onClose={() => setResolvingId(undefined)}
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>记录凭证差异处理结论</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Alert status="info" mb="4" borderRadius="5px">
              全部差异处理完成且各系统持有最新成功凭证后，请求才允许关闭。
            </Alert>
            <FormControl isRequired>
              <FormLabel>处理结论</FormLabel>
              <Textarea
                value={resolution}
                onChange={(event) => setResolution(event.target.value)}
                placeholder="说明差异原因、采取的补救动作和最终判定"
              />
            </FormControl>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={() => setResolvingId(undefined)}>
              取消
            </Button>
            <Button colorScheme="brand" isLoading={resolveDiscrepancy.isPending} onClick={submitResolution}>
              确认处理完成
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 逐系统确认 */}
      <Modal isOpen={Boolean(confirmSystemId)} onClose={() => setConfirmSystemId(undefined)}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>
            确认系统履约结果：{confirmSystemId ? nameOf(confirmSystemId) : ''}
          </ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Alert status="info" mb="4" borderRadius="5px">
              确认后该系统视为完成差异核对，后续迟到凭证仅留档，不退回待处理。
            </Alert>
            <FormControl>
              <FormLabel>确认说明（可选）</FormLabel>
              <Textarea
                value={confirmNote}
                onChange={(event) => setConfirmNote(event.target.value)}
                placeholder="说明核对范围与结论"
              />
            </FormControl>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={() => setConfirmSystemId(undefined)}>
              取消
            </Button>
            <Button colorScheme="teal" isLoading={confirmSystem.isPending} onClick={submitConfirm}>
              确认系统
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  )
}
