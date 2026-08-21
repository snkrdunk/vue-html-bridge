<script setup lang="ts">
interface Item {
  id: string;
  label: string;
}

const props = defineProps<{ items: Item[] }>();
</script>
<template>
  <p v-if="props.items.length === 0">No items.</p>
  <ul v-else>
    <li v-for="item in props.items" :key="item.id">{{ item.label }}</li>
  </ul>
</template>
