"use client";

// Provider + model picker. Single Select that lists every whitelisted
// (provider, model) pair from lib/models.ts. We encode the choice as
// "provider:model" in the value so we can re-derive both fields without
// keeping two Select widgets in sync.
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MODELS, type ModelChoice } from "@/lib/models";

interface Props {
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  disabled?: boolean;
}

export function ModelPicker({ value, onChange, disabled }: Props) {
  const encoded = `${value.provider}:${value.model}`;
  return (
    <Select
      value={encoded}
      onValueChange={(v) => {
        const [provider, model] = v.split(":");
        const choice = MODELS.find(
          (m) => m.provider === provider && m.model === model,
        );
        if (choice) onChange(choice);
      }}
      disabled={disabled}
    >
      <SelectTrigger className="w-[260px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MODELS.map((m) => (
          <SelectItem key={`${m.provider}:${m.model}`} value={`${m.provider}:${m.model}`}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
