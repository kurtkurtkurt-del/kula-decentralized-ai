import { useState } from 'react';
import { router } from 'expo-router';
import PickerSheet from '@/components/PickerSheet';
import { Panel, Row, Value } from '@/components/Row';
import { useLang } from '@/i18n';
import { isVision } from '@/llm/catalog';
import { bytesOf, saveSettings, useLocalModels, useSettings } from '@/llm/store';

const AUTO = 'auto';
const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} gb`;

// Settings › app: "vision model" (10.11.2026), the model that reads photos in the chat and in
// night projects (llm/vision.ts chosenVision). "auto" is the smallest vision model on the
// phone; with none, the row says so and opens the models tab.
export default function VisionSetting() {
  const { t } = useLang();
  const settings = useSettings();
  const local = useLocalModels();
  const [open, setOpen] = useState(false);
  const list = local.filter(isVision).sort((a, b) => bytesOf(a) - bytesOf(b));
  const picked = settings.visionModelId ? list.find((m) => m.id === settings.visionModelId) ?? null : null;
  const auto = list[0] ?? null;
  const value = picked ? picked.name.toLowerCase() : auto ? t('vision.setting.auto', { model: auto.name.toLowerCase() }) : '—';
  return (
    <>
      <Panel>
        <Row
          label={t('vision.setting')}
          hint={list.length ? t('vision.setting.hint') : t('vision.setting.none')}
          onPress={() => (list.length ? setOpen(true) : router.push('/models'))}
          right={<Value text={value} more />}
        />
      </Panel>
      <PickerSheet
        open={open}
        title={t('vision.setting')}
        options={[{ id: AUTO, label: auto ? t('vision.setting.auto', { model: auto.name.toLowerCase() }) : '—' }, ...list.map((m) => ({ id: m.id, label: m.name.toLowerCase(), extra: gb(bytesOf(m)) }))]}
        selected={picked?.id ?? AUTO}
        onSelect={(id) => saveSettings({ visionModelId: id === AUTO ? null : id })}
        onClose={() => setOpen(false)}
        note={t('vision.local')}
      />
    </>
  );
}
