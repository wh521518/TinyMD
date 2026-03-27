export const ASSET_IMPORT_STATUS_DOM_EVENT = "tinymd-asset-import-status";

export type AttachmentImportStatus = "queued" | "completed" | "failed";

export type AttachmentImportState = {
  documentPath: string;
  relativePath: string;
  fileName: string;
  status: AttachmentImportStatus;
  error?: string | null;
};

const attachmentImportStateByKey = new Map<string, AttachmentImportState>();

const getAttachmentImportKey = (documentPath: string, relativePath: string) =>
  `${documentPath}\u0000${relativePath}`;

export const getAttachmentImportState = (
  documentPath: string | null | undefined,
  relativePath: string | null | undefined,
) => {
  if (!documentPath || !relativePath) {
    return null;
  }

  return attachmentImportStateByKey.get(getAttachmentImportKey(documentPath, relativePath)) ?? null;
};

export const publishAttachmentImportState = (state: AttachmentImportState) => {
  const key = getAttachmentImportKey(state.documentPath, state.relativePath);
  if (state.status === "completed") {
    attachmentImportStateByKey.delete(key);
  } else {
    attachmentImportStateByKey.set(key, state);
  }

  window.dispatchEvent(
    new CustomEvent<AttachmentImportState>(ASSET_IMPORT_STATUS_DOM_EVENT, {
      detail: state,
    }),
  );
};
