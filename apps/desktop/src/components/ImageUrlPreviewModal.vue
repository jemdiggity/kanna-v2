<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { invoke } from "../invoke";
import {
  useEmbeddableView,
  type EmbeddableViewProps,
} from "../composables/useEmbeddableView";

const props = defineProps<EmbeddableViewProps & {
  imageUrl: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const { bringToFront, overlayClass, overlayStyle, dismissOnScrimClick } =
  useEmbeddableView(props);
const loadedLocalImageSrc = ref<string | null>(null);
const loadError = ref<string | null>(null);
const isLocalImage = computed(() => props.imageUrl.startsWith("/"));
const imageSrc = computed(() =>
  isLocalImage.value ? loadedLocalImageSrc.value : props.imageUrl
);

watch(() => props.imageUrl, async (imageUrl) => {
  loadedLocalImageSrc.value = null;
  loadError.value = null;
  if (!imageUrl.startsWith("/")) return;

  try {
    loadedLocalImageSrc.value = await invoke<string>("read_image_file_data_url", { path: imageUrl });
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  }
}, { immediate: true });

defineExpose({ bringToFront });
</script>

<template>
  <div
    class="modal-overlay"
    :class="overlayClass"
    :style="overlayStyle"
    @click.self="dismissOnScrimClick(() => emit('close'))"
  >
    <div class="image-preview-modal">
      <header class="image-preview-header">
        <a class="image-source" :href="imageSrc || undefined">{{ props.imageUrl }}</a>
        <button type="button" class="close-button" aria-label="Close image preview" @click="emit('close')">
          &times;
        </button>
      </header>
      <div class="image-preview-body">
        <div v-if="loadError" class="image-preview-status image-preview-error">{{ loadError }}</div>
        <div v-else-if="!imageSrc" class="image-preview-status">Loading image...</div>
        <img v-else :src="imageSrc" :alt="props.imageUrl" decoding="async" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay.embedded {
  position: relative;
  inset: auto;
  flex: 1;
  min-height: 0;
  background: none;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
  background: var(--kn-overlay-scrim);
}

.image-preview-modal {
  display: flex;
  flex-direction: column;
  width: min(980px, 96vw);
  max-height: 92vh;
  overflow: hidden;
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  background: var(--kn-bg-panel);
  box-shadow: var(--kn-shadow-modal);
}

.image-preview-header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 8px 10px 8px 12px;
  border-bottom: 1px solid var(--kn-border-default);
}

.image-source {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--kn-text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.close-button {
  flex: none;
  width: 28px;
  height: 28px;
  border: 1px solid var(--kn-border-default);
  border-radius: 6px;
  background: var(--kn-bg-panel-raised);
  color: var(--kn-text-primary);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
}

.close-button:hover {
  background: var(--kn-bg-hover);
}

.image-preview-body {
  display: flex;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  overflow: auto;
  background: var(--kn-bg-app);
}

.image-preview-body img {
  display: block;
  max-width: 100%;
  max-height: calc(92vh - 44px);
  object-fit: contain;
}

.image-preview-status {
  padding: 20px;
  color: var(--kn-text-secondary);
  font-size: 13px;
}

.image-preview-error {
  color: var(--kn-danger);
}
</style>
