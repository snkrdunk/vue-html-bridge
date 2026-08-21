<script setup lang="ts">
type Status = "active" | "inactive" | "pending";

const props = defineProps<{ status: Status; disabled: boolean }>();
</script>
<template>
  <button
    :disabled="props.disabled"
    :class="props.status === 'active' ? 'is-active' : 'is-inactive'"
  >
    {{ props.status }}
  </button>
</template>
