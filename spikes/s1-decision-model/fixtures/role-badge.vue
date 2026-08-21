<script setup lang="ts">
import type { Role } from "./shared-types.js";

const props = defineProps<{ role: Role }>();
</script>
<template>
  <span :class="props.role === 'admin' ? 'is-admin' : 'is-member'">{{
    props.role
  }}</span>
</template>
