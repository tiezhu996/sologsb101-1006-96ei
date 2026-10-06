<script setup lang="ts">
/**
 * <ObservationTag> 整治完工后观察期状态标签
 * 被速率分级、复测对比、整治建议与备份、裂缝初测录入页消费。
 */
import { computed } from 'vue'
import { InfoFilled, SuccessFilled, Timer, WarningFilled } from '@element-plus/icons-vue'
import { observationTone, type ObservationStatus } from '@/utils/observation'

const props = withDefaults(
  defineProps<{
    status: ObservationStatus | null
    size?: 'small' | 'default'
    /** 是否在标签后追加简短说明 */
    showHint?: boolean
  }>(),
  {
    size: 'small',
    showHint: false
  }
)

const tone = computed(() => (props.status ? observationTone(props.status.phase) : 'info'))

const iconComponent = computed(() => {
  switch (props.status?.phase) {
    case '可结案':
      return SuccessFilled
    case '观察中':
      return Timer
    case '待补日期':
    case '缺基准':
      return WarningFilled
    default:
      return InfoFilled
  }
})

const text = computed(() => props.status?.label ?? '未到观察期')
const hint = computed(() => props.status?.hint ?? '')
const dotClass = computed(() => `is-${props.size}`)
</script>

<template>
  <span class="obs-tag">
    <el-tag :type="tone" :size="size" effect="light" round>
      <el-icon class="obs-tag__icon"><component :is="iconComponent" /></el-icon>
      {{ text }}
    </el-tag>
    <el-tooltip v-if="showHint && hint" :content="hint" placement="top">
      <span :class="['obs-tag__dot', dotClass]" />
    </el-tooltip>
  </span>
</template>

<style scoped>
.obs-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.obs-tag__icon {
  margin-right: 2px;
}

.obs-tag__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #d68910;
}

.obs-tag__dot.is-small {
  width: 5px;
  height: 5px;
}
</style>
