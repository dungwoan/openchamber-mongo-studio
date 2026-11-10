/**
 * Hộp thoại sửa hoặc thêm document dạng JSON. Nội dung được kiểm tra cú pháp ngay khi gõ
 * bằng cùng parser với service, và luôn có bước xác nhận trước khi ghi.
 */
import { mountBanner, mountButton, mountTextField } from '@openchamber/sdk/ui';

import { parseLiteral, QuerySyntaxError } from '../shared/query-parser.ts';
import { ApiError } from './api.ts';
import { confirmDialog, openDialog } from './dialogs.ts';
import { append, h, slot } from './dom.ts';

export type DocumentDialogOptions = {
  title: string;
  initial: string;
  confirmTitle: string;
  confirmMessage: string;
  /** Lưu nội dung; ném ApiError nếu server từ chối (hiển thị trong hộp thoại). */
  save: (text: string) => Promise<void>;
  onSaved: () => void;
};

/** Kiểm tra cú pháp và kiểu (phải là một object). Trả về thông báo lỗi hoặc null. */
export function documentProblem(text: string): string | null {
  try {
    const value = parseLiteral(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return 'Document phải là một đối tượng {...}, không phải mảng hay giá trị đơn.';
    }
    return null;
  } catch (error) {
    if (error instanceof QuerySyntaxError) return error.message;
    return 'Nội dung không hợp lệ';
  }
}

/**
 * Mở hộp thoại soạn thảo document.
 *
 * Args:
 *   options: Tiêu đề, nội dung ban đầu, và hàm lưu.
 */
export function openDocumentDialog(options: DocumentDialogOptions): void {
  const dialog = openDialog(options.title, true);
  const { body } = dialog;
  let text = options.initial;
  let busy = false;

  const bannerSlot = slot('ms-slot ms-slot-banner');
  const editorSlot = slot();
  const actions = h('div', 'ms-dialog-actions');
  const cancelSlot = slot('ms-slot ms-slot-inline');
  const saveSlot = slot('ms-slot ms-slot-inline');
  append(actions, cancelSlot, saveSlot);
  append(body, editorSlot, bannerSlot, actions);

  let banner: ReturnType<typeof mountBanner> | null = null;
  const showError = (title: string, detail?: string): void => {
    if (!banner) banner = mountBanner(bannerSlot, { tone: 'error', title, body: detail });
    else banner.update({ tone: 'error', title, body: detail });
  };
  const clearError = (): void => {
    banner?.dispose();
    banner = null;
    bannerSlot.replaceChildren();
  };

  let save: ReturnType<typeof mountButton> | null = null;
  let editor: ReturnType<typeof mountTextField> | null = null;
  editor = mountTextField(editorSlot, {
    label: 'Document (JSON)',
    value: text,
    multiline: true,
    rows: 18,
    mono: true,
    helper: 'Dùng JSON hoặc ObjectId("..."), ISODate("..."), NumberLong("..."), UUID("...").',
    onChange: (value) => {
      text = value;
      const problem = documentProblem(value);
      editor?.update({ error: problem ?? undefined });
      save?.update({ disabled: problem !== null });
    },
  });
  const initialProblem = documentProblem(text);
  if (initialProblem) editor?.update({ error: initialProblem });

  mountButton(cancelSlot, { label: 'Cancel', variant: 'ghost', onClick: dialog.close });
  save = mountButton(saveSlot, {
    label: 'Save',
    disabled: initialProblem !== null,
    onClick: () => {
      if (busy) return;
      void confirmAndSave();
    },
  });

  const confirmAndSave = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: options.confirmTitle,
      message: options.confirmMessage,
      confirmLabel: 'Save',
    });
    if (!ok) return;
    busy = true;
    save?.update({ loading: true, disabled: true });
    clearError();
    try {
      await options.save(text);
      dialog.close();
      options.onSaved();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Không lưu được document';
      showError('Không lưu được', message);
    } finally {
      busy = false;
      save?.update({ loading: false, disabled: documentProblem(text) !== null });
    }
  };
}
