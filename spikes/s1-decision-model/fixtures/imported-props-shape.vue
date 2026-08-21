<script setup lang="ts">
import type { Props } from "./props-shape.js";

const props = defineProps<Props>();
</script>
<template>
  <span :class="props.role === 'admin' ? 'is-admin' : 'is-member'">{{
    props.role
  }}</span>
</template>
