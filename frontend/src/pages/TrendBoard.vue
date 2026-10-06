<script setup lang="ts">
/**
 * /trends 发展速率分级与预警
 * 按 mm/月 速率排序并标记预警裂缝，可一键生成整治建议草稿。
 * 消费 Crack、Survey、Advice；复用 <LevelTag>、<StatBadge>、<FilterBar>。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, MagicStick, View } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import LevelTag from '@/components/common/LevelTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useCrackStore, type CrackEnriched } from '@/stores/crackStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useAdviceStore } from '@/stores/adviceStore'
import { useCrackTrend } from '@/hooks/useCrackTrend'
import { db, type AdviceRow } from '@/utils/db'
import {
  ADVICE_LEVELS,
  ADVICE_MEASURES,
  ADVICE_STATES,
  LEVEL_MEASURE_SUGGEST,
  isPostCompletionState,
  type Advice,
  type AdviceDraft
} from '@/types/advice'
import { basisText, RATE_SEVERE, RATE_WARNING, round } from '@/utils/rate'
import { observationBadgeText, type ObservationStatus } from '@/utils/observation'
import type { CrackDirection, CrackPosition } from '@/types/crack'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const crackStore = useCrackStore()
const surveyStore = useSurveyStore()
const sectionStore = useSectionStore()
const adviceStore = useAdviceStore()

const drawerVisible = ref(false)
const drawerCrackId = ref<string | null>(null)
const drawerTrend = useCrackTrend(drawerCrackId)

/* ------------------------------ 筛选 ------------------------------ */

const filterModel = computed<FilterModel>(() => ({
  keyword: crackStore.filter.keyword,
  line: crackStore.filter.lines,
  position: crackStore.filter.positions,
  direction: crackStore.filter.directions
}))

const filterSelects = computed(() => [
  { key: 'line', label: '线路', options: sectionStore.lineOptions },
  { key: 'position', label: '部位', options: crackStore.positionOptions.map((item) => ({ label: item, value: item })) },
  { key: 'direction', label: '走向', options: crackStore.directionOptions.map((item) => ({ label: item, value: item })) }
])

function onFilterChange(model: FilterModel): void {
  crackStore.patchFilter({
    keyword: String(model.keyword ?? ''),
    lines: Array.isArray(model.line) ? model.line : [],
    positions: (Array.isArray(model.position) ? model.position : []) as CrackPosition[],
    directions: (Array.isArray(model.direction) ? model.direction : []) as CrackDirection[]
  })
}

/* ------------------------------ 排行 ------------------------------ */

const ranked = computed<CrackEnriched[]>(() => {
  const source = crackStore.onlyWarning
    ? crackStore.filtered.filter((item) => item.level !== '一般')
    : crackStore.filtered
  return [...source].sort((a, b) => b.rate - a.rate)
})

const severeRows = computed(() => crackStore.enriched.filter((item) => item.level === '严重'))
const warningRows = computed(() => crackStore.enriched.filter((item) => item.level !== '一般'))

const averageRate = computed(() => {
  const rated = crackStore.enriched.filter((item) => item.surveyCount > 1)
  if (rated.length === 0) return 0
  return round(rated.reduce((sum, item) => sum + item.rate, 0) / rated.length, 3)
})

/* --------------------------- 建议生成 --------------------------- */

function adviceOf(crackId: string): Advice | null {
  return adviceStore.adviceOf(crackId)
}

async function generateAdvice(row: CrackEnriched): Promise<void> {
  if (adviceOf(row.crack.id)) {
    ElMessage.info(`${row.crack.code} 已存在整治建议，可在「建议与备份」页维护`)
    return
  }
  const now = Date.now()
  const level = row.level
  const advice: AdviceRow = {
    id: `ad_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    crackId: row.crack.id,
    level,
    measure: LEVEL_MEASURE_SUGGEST[level],
    basis: basisText(row.rate, level),
    state: '待下发',
    createdAt: now,
    updatedAt: now
  }
  await db.advices.put(advice)
  ElMessage.success(`已按「${level}」生成整治建议草稿：${advice.measure}`)
}

/* --------------------------- 观察结案 --------------------------- */

function observationOf(crackId: string): ObservationStatus | null {
  return adviceStore.observationOf(crackId)
}

function obsBadge(crackId: string): string {
  return observationBadgeText(observationOf(crackId))
}

async function closeAdvice(row: CrackEnriched): Promise<void> {
  const advice = adviceOf(row.crack.id)
  if (!advice) return
  const error = await adviceStore.closeAdvice(advice.id)
  if (error) {
    ElMessage.warning(`${row.crack.code} ${error}`)
    return
  }
  ElMessage.success(`${row.crack.code} 完工后观察判定通过，已结案`)
}

/* --------------------------- 建议维护 --------------------------- */

const adviceDialogVisible = ref(false)
const adviceForm = reactive<AdviceDraft>({
  crackId: '',
  level: '一般',
  measure: '观测',
  basis: '',
  state: '待下发',
  completedDate: ''
})

function openAdviceEdit(row: CrackEnriched): void {
  const advice = adviceOf(row.crack.id)
  if (!advice) {
    void generateAdvice(row)
    return
  }
  Object.assign(adviceForm, adviceStore.draftOf(advice))
  adviceDialogVisible.value = true
}

async function submitAdvice(): Promise<void> {
  const advice = adviceOf(adviceForm.crackId)
  if (!advice) return
  const error = await adviceStore.saveAdvice(advice.id, { ...adviceForm })
  if (error) {
    ElMessage.warning(error)
    return
  }
  ElMessage.success('整治建议已更新')
  adviceDialogVisible.value = false
}

async function removeAdvice(row: CrackEnriched): Promise<void> {
  const advice = adviceOf(row.crack.id)
  if (!advice) return
  const confirmed = await ElMessageBox.confirm(
    `确认撤销「${row.crack.code}」的整治建议？撤销后该裂缝回到未生成状态。`,
    '撤销确认',
    { type: 'warning', confirmButtonText: '确认撤销', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  await adviceStore.removeAdvice(advice.id)
  ElMessage.success('整治建议已撤销')
}

function openDrawer(row: CrackEnriched): void {
  drawerCrackId.value = row.crack.id
  drawerVisible.value = true
}

/* --------------------------- 抽屉派生 --------------------------- */

const drawerCrack = computed(
  () => crackStore.enriched.find((item) => item.crack.id === drawerCrackId.value) ?? null
)

const rateThresholds = computed(() => ({ warning: RATE_WARNING, severe: RATE_SEVERE }))

const drawerAdvice = computed(() =>
  drawerCrackId.value ? adviceOf(drawerCrackId.value) : null
)

/** 抽屉内完工后观察状态 */
const drawerObservation = computed(() =>
  drawerCrackId.value ? observationOf(drawerCrackId.value) : null
)

/** 观察测次判定明细（与 points 按 seq 对齐） */
const drawerCheckBySeq = computed<Record<number, { ok: boolean; delta: number; rate: number; reason: string | null }>>(() => {
  const status = drawerObservation.value
  if (!status) return {}
  const map: Record<number, { ok: boolean; delta: number; rate: number; reason: string | null }> = {}
  status.postSurveys.forEach((survey, index) => {
    map[survey.seq] = status.checks[index]
  })
  return map
})

async function drawerCloseAdvice(): Promise<void> {
  if (!drawerCrack.value) return
  await closeAdvice(drawerCrack.value)
}

function crackRowKey(row: CrackEnriched): string {
  return row.crack.id
}

function sortByRate(a: CrackEnriched, b: CrackEnriched): number {
  return a.rate - b.rate
}

function onOnlyWarningChange(value: string | number | boolean): void {
  crackStore.setOnlyWarning(value === true)
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">发展速率分级与预警</h2>
        <p class="page-head__desc">
          按月均速率降序排列，速率 ≥ {{ rateThresholds.warning }} mm/月 记预警，≥ {{ rateThresholds.severe }} mm/月 判严重。
        </p>
      </div>
      <div class="page-head__actions">
        <el-switch
          :model-value="crackStore.onlyWarning"
          active-text="仅看预警"
          inline-prompt
          @update:model-value="onOnlyWarningChange"
        />
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="裂缝总数" :value="crackStore.cracks.length" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="预警裂缝" :value="warningRows.length" suffix="条" icon="WarningFilled" tone="warning" />
      <StatBadge label="严重裂缝" :value="severeRows.length" suffix="条" icon="CircleCloseFilled" tone="danger" />
      <StatBadge label="平均月均速率" :value="averageRate.toFixed(3)" suffix="mm/月" icon="TrendCharts" tone="info" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索裂缝编号 / 环号"
      @change="onFilterChange"
    />

    <div class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <h3 class="panel-title">速率排行（{{ ranked.length }} / {{ crackStore.cracks.length }}）</h3>
        <span class="muted">点击「曲线」查看该裂缝全部测次与建议状态</span>
      </div>

      <EmptyPanel
        v-if="ranked.length === 0"
        title="没有需要分级的裂缝"
        description="当前条件下没有超过预警阈值或尚未复测的裂缝，可关闭「仅看预警」查看全部。"
        secondary-text="查看全部裂缝"
        compact
        @secondary="crackStore.setOnlyWarning(false)"
      />

      <el-table v-else :data="ranked" border stripe :row-key="crackRowKey">
        <el-table-column label="排名" width="70">
          <template #default="{ $index }">{{ $index + 1 }}</template>
        </el-table-column>
        <el-table-column label="裂缝编号" width="140">
          <template #default="{ row }"><strong>{{ row.crack.code }}</strong></template>
        </el-table-column>
        <el-table-column label="区间 / 里程" min-width="170">
          <template #default="{ row }">{{ row.sectionLabel }}</template>
        </el-table-column>
        <el-table-column label="环号" width="96">
          <template #default="{ row }">{{ row.ringLabel }}</template>
        </el-table-column>
        <el-table-column label="部位/走向" width="110">
          <template #default="{ row }">{{ row.crack.position }} / {{ row.crack.direction }}</template>
        </el-table-column>
        <el-table-column label="初测宽度" width="104">
          <template #default="{ row }">
            {{ (surveyStore.summaryOf(row.crack.id)?.firstWidth ?? row.crack.widthMm).toFixed(2) }} mm
          </template>
        </el-table-column>
        <el-table-column label="最新宽度" width="104">
          <template #default="{ row }">
            {{ (surveyStore.summaryOf(row.crack.id)?.latestWidth ?? row.crack.widthMm).toFixed(2) }} mm
          </template>
        </el-table-column>
        <el-table-column label="累计变化" width="104">
          <template #default="{ row }">
            {{ (surveyStore.summaryOf(row.crack.id)?.totalDelta ?? 0).toFixed(2) }} mm
          </template>
        </el-table-column>
        <el-table-column label="月均速率" width="128" sortable :sort-method="sortByRate">
          <template #default="{ row }">
            <span :style="{ color: row.level === '严重' ? '#c0392b' : row.level === '较重' ? '#d68910' : '#1e8449' }">
              {{ row.rate.toFixed(3) }} mm/月
            </span>
          </template>
        </el-table-column>
        <el-table-column label="分级" width="160">
          <template #default="{ row }">
            <LevelTag :level="row.level" :rate="row.surveyCount > 1 ? row.rate : undefined" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="建议" min-width="180">
          <template #default="{ row }">
            <template v-if="adviceOf(row.crack.id)">
              <el-tag
                size="small"
                effect="plain"
                :type="adviceOf(row.crack.id)?.state === '已结案' ? 'success' : adviceOf(row.crack.id)?.state === '已完成' ? 'warning' : 'success'"
              >
                {{ adviceOf(row.crack.id)?.state }}
              </el-tag>
              <el-tag
                v-if="obsBadge(row.crack.id)"
                size="small"
                :type="adviceOf(row.crack.id)?.state === '已结案' ? 'success' : observationOf(row.crack.id)?.canClose ? 'success' : 'warning'"
                effect="light"
                style="margin-left: 4px"
              >
                {{ obsBadge(row.crack.id) }}
              </el-tag>
            </template>
            <span v-else class="muted">未生成</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openDrawer(row)">
              <el-icon><View /></el-icon> 曲线
            </el-button>
            <el-button size="small" text type="primary" :icon="MagicStick" @click="generateAdvice(row)">
              生成建议
            </el-button>
            <el-button
              size="small"
              text
              type="primary"
              :icon="Edit"
              :disabled="!adviceOf(row.crack.id)"
              @click="openAdviceEdit(row)"
            >
              维护
            </el-button>
            <el-button
              v-if="adviceOf(row.crack.id)?.state === '已完成'"
              size="small"
              text
              type="success"
              :disabled="!observationOf(row.crack.id)?.canClose"
              @click="closeAdvice(row)"
            >
              结案
            </el-button>
            <el-button
              v-else
              size="small"
              text
              type="danger"
              :icon="Delete"
              :disabled="!adviceOf(row.crack.id)"
              @click="removeAdvice(row)"
            >
              撤销
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="adviceDialogVisible" title="维护整治建议" width="560px">
      <el-form label-width="110px">
        <el-form-item label="裂缝">
          <el-input :model-value="adviceForm.crackId ? crackStore.cracks.find((item) => item.id === adviceForm.crackId)?.code ?? '' : ''" disabled />
        </el-form-item>
        <el-form-item label="建议等级">
          <el-select v-model="adviceForm.level" style="width: 100%">
            <el-option v-for="item in ADVICE_LEVELS" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="建议措施">
          <el-radio-group v-model="adviceForm.measure">
            <el-radio-button v-for="item in ADVICE_MEASURES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="判定依据">
          <el-input v-model="adviceForm.basis" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="adviceForm.state" style="width: 100%">
            <el-option v-for="item in ADVICE_STATES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="完工日期">
          <el-date-picker
            v-model="adviceForm.completedDate"
            type="date"
            value-format="YYYY-MM-DD"
            :placeholder="isPostCompletionState(adviceForm.state) ? '必填：观察按完工日期起算' : '完工后填写'"
            :disabled="!isPostCompletionState(adviceForm.state)"
            style="width: 100%"
          />
        </el-form-item>
        <el-alert
          v-if="isPostCompletionState(adviceForm.state)"
          type="warning"
          :closable="false"
          title="已完工建议必须填写完工日期：第一次观察对照完工前最后一次读数，连续三次稳定才可结案。"
        />
      </el-form>
      <template #footer>
        <el-button @click="adviceDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAdvice">保存</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="drawerVisible" :title="drawerCrack ? `${drawerCrack.crack.code} · 发展态势` : '裂缝详情'" size="620px">
      <template v-if="drawerCrack">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="区间">{{ drawerCrack.sectionLabel }}</el-descriptions-item>
          <el-descriptions-item label="环号">{{ drawerCrack.ringLabel }}</el-descriptions-item>
          <el-descriptions-item label="部位/走向">
            {{ drawerCrack.crack.position }} / {{ drawerCrack.crack.direction }}
          </el-descriptions-item>
          <el-descriptions-item label="台账状态">{{ drawerCrack.crack.state }}</el-descriptions-item>
          <el-descriptions-item label="累计变化">{{ drawerTrend.delta.value.toFixed(2) }} mm</el-descriptions-item>
          <el-descriptions-item label="月均速率">{{ drawerTrend.rate.value.toFixed(3) }} mm/月</el-descriptions-item>
        </el-descriptions>

        <div style="margin: 14px 0">
          <LevelTag :level="drawerTrend.level.value" :rate="drawerTrend.rate.value" size="large" />
          <span v-if="drawerAdvice" class="muted" style="margin-left: 10px">
            建议：{{ drawerAdvice.measure }} · {{ drawerAdvice.state }}
            <template v-if="isPostCompletionState(drawerAdvice.state)">
              · 完工 {{ drawerAdvice.completedDate || '待补' }}
            </template>
          </span>
          <span v-else class="muted" style="margin-left: 10px">尚未生成整治建议</span>
        </div>

        <!-- 完工后观察判定：观察以完工日期为准，不用整治前稳定读数充数 -->
        <el-alert
          v-if="drawerObservation"
          :type="drawerObservation.phase === 'closed' || drawerObservation.canClose ? 'success' : drawerObservation.phase === 'datePending' || drawerObservation.missingDateCount > 0 ? 'error' : 'warning'"
          :closable="false"
          show-icon
          style="margin: 10px 0"
        >
          <template #title>
            <div>完工后观察判定（完工日 {{ drawerObservation.completedDate || '待补' }}）</div>
            <div style="font-weight: 400; margin-top: 2px">{{ drawerObservation.statusText }}</div>
            <div v-if="drawerObservation.baseline" style="font-weight: 400; margin-top: 2px">
              基线：完工前最后一次读数 {{ drawerObservation.baseline.widthMm.toFixed(2) }} mm
              （{{ drawerObservation.baseline.date }}）· 已连续稳定 {{ drawerObservation.streak }} 次，还差 {{ drawerObservation.remaining }} 次
            </div>
          </template>
          <template #default>
            <div v-if="drawerAdvice?.state === '已完成'" style="margin-top: 8px">
              <el-button size="small" type="success" plain :disabled="!drawerObservation.canClose" @click="drawerCloseAdvice">
                满足条件，结案
              </el-button>
              <span v-if="!drawerObservation.canClose" class="muted" style="margin-left: 8px; font-size: 12px">
                需连续三次增幅 ≤ 0.05 mm 且最新速率低于 {{ RATE_WARNING }} mm/月
              </span>
            </div>
          </template>
        </el-alert>

        <h4 class="panel-subtitle">测次序列</h4>
        <el-table :data="drawerTrend.points.value" border stripe size="small">
          <el-table-column prop="seq" label="测次" width="70" />
          <el-table-column label="日期" width="150">
            <template #default="{ row }">
              <span v-if="row.date === '待补'" style="color: #c0392b; font-weight: 600">待补</span>
              <span v-else>{{ row.date }}</span>
              <el-tag
                v-if="drawerObservation?.baseline?.seq === row.seq"
                size="small"
                type="info"
                effect="plain"
                style="margin-left: 4px"
              >
                完工前基线
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="宽度(mm)" width="110">
            <template #default="{ row }">{{ row.widthMm.toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="变化量(mm)" width="120">
            <template #default="{ row }">{{ row.deltaWidthMm.toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="月均速率" width="120">
            <template #default="{ row }">{{ row.rate.toFixed(3) }}</template>
          </el-table-column>
          <el-table-column label="观察判定" width="110">
            <template #default="{ row }">
              <template v-if="drawerCheckBySeq[row.seq]">
                <el-tag size="small" :type="drawerCheckBySeq[row.seq].ok ? 'success' : 'danger'" effect="light">
                  {{ drawerCheckBySeq[row.seq].ok ? '稳定' : (drawerCheckBySeq[row.seq].reason || '待补') }}
                </el-tag>
              </template>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>

        <div v-if="drawerAdvice" class="panel" style="margin-top: 14px">
          <h4 class="panel-subtitle" style="margin-top: 0">整治建议</h4>
          <p class="muted" style="line-height: 1.7">{{ drawerAdvice.basis }}</p>
        </div>
      </template>
      <EmptyPanel v-else title="未选择裂缝" description="从速率排行中选择一条裂缝查看详情。" compact />
    </el-drawer>
  </div>
</template>

<style scoped>
.panel-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.panel-subtitle {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}
</style>
