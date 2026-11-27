// Local copies of captured files, under the app's document directory at drafts/<draftId>/.
import { Directory, File, Paths } from "expo-file-system";

function draftDirectory(draftId: string): Directory {
  return new Directory(Paths.document, "drafts", draftId);
}

/** Copies a picked or captured file into the draft's directory and returns its new uri. */
export function keepLocalCopy(
  draftId: string,
  sourceUri: string,
  localId: string,
  extension: string,
): string {
  const directory = draftDirectory(draftId);
  if (!directory.exists) directory.create({ intermediates: true });
  const target = new File(directory, `${localId}.${extension}`);
  new File(sourceUri).copy(target);
  return target.uri;
}

/** The local copy's real size, or null when it can't be read. */
export function sizeOfLocalCopy(uri: string): number | null {
  try {
    const file = new File(uri);
    return file.exists ? file.size : null;
  } catch {
    return null;
  }
}

export function removeLocalCopy(uri: string): void {
  const file = new File(uri);
  if (file.exists) file.delete();
}

export function removeDraftFiles(draftId: string): void {
  const directory = draftDirectory(draftId);
  if (directory.exists) directory.delete();
}
