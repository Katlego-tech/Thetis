import { View } from "react-native";
import { checkLocalFile, type EvidenceItem } from "../evidence/upload";
import { formatSize } from "../format";
import { radius, usePalette } from "../theme";
import { Button } from "./Button";
import { Txt } from "./Txt";

export interface FileRowProps {
  label: string;
  requirement: string;
  item: EvidenceItem | null;
  online: boolean;
  readOnly: boolean;
  cameraOnly?: boolean;
  onTakePhoto: () => void;
  onChooseFile: () => void;
  onRetry: () => void;
  /** Removes a file that was never registered, so another can be taken. */
  onRemove: () => void;
}

function stateLine(item: EvidenceItem | null, online: boolean): { text: string; bad: boolean } {
  if (!item) return { text: "Not added.", bad: false };
  const local = checkLocalFile(item.mime, item.sizeBytes);
  if (local?.kind === "too_large") {
    return {
      text: `Too large: ${formatSize(item.sizeBytes)} of 20 MB. Take a smaller photo or choose another file.`,
      bad: true,
    };
  }
  if (local?.kind === "type")
    return { text: "This file type can't be stored. Use PDF, JPEG or PNG.", bad: true };
  switch (item.upload) {
    case "local":
      return {
        text: online ? "On this phone, waiting to upload." : "On this phone, not uploaded.",
        bad: false,
      };
    case "registering":
    case "uploading":
    case "finalizing":
      return { text: "Uploading", bad: false };
    case "finalized":
      return { text: `Uploaded. SHA-256 ${item.sha256?.slice(0, 8) ?? ""}`, bad: false };
    case "failed":
      return { text: "Upload failed. Your file is still on this phone.", bad: true };
    case "rejected":
      return {
        text: "The stored file did not match what was sent. Retry uploads a new version.",
        bad: true,
      };
  }
}

/** One evidence row: label, requirement, state, and the action that fits the state. */
export function FileRow(props: FileRowProps) {
  const palette = usePalette();
  const { item } = props;
  const line = stateLine(item, props.online);
  const local = item ? checkLocalFile(item.mime, item.sizeBytes) : null;
  const replaceable = item !== null && item.upload === "local";
  const retry =
    item !== null && local === null && (item.upload === "failed" || item.upload === "rejected");
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: palette.rule,
        borderRadius: radius,
        backgroundColor: palette.sheet,
        paddingVertical: 10,
        paddingHorizontal: 12,
        minHeight: 56,
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <View style={{ flexShrink: 1 }}>
          <Txt variant="label">{props.label}</Txt>
          <Txt variant="caption" tone={line.bad ? "refuse" : "ink2"} live>
            {`${props.requirement} ${line.text}`}
          </Txt>
        </View>
        {!props.readOnly && retry ? (
          <Button
            label="Retry"
            kind="quiet"
            inline
            disabled={!props.online}
            onPress={props.onRetry}
          />
        ) : null}
        {!props.readOnly && replaceable ? (
          <Button label="Replace" kind="quiet" inline onPress={props.onRemove} />
        ) : null}
      </View>
      {!props.readOnly && item === null ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button label="Take photo" kind="quiet" inline onPress={props.onTakePhoto} />
          {props.cameraOnly ? null : (
            <Button label="Choose file" kind="quiet" inline onPress={props.onChooseFile} />
          )}
        </View>
      ) : null}
    </View>
  );
}
