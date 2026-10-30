import type { TranslationOverrides } from '../define-locale'

export const prompts: TranslationOverrides['prompts'] = {
  gatewayDisconnected: 'بوابة الوكيل غير متصلة',
  sudoSendFailed: 'فشل إرسال كلمة مرور sudo',
  secretSendFailed: 'فشل إرسال السر',
  sudoTitle: 'مطلوب sudo',
  sudoDesc: 'يحتاج الوكيل إلى كلمة مرور sudo لتشغيل أمر يتطلب صلاحيات. تُرسل فقط إلى وكيلك المحلي.',
  sudoPlaceholder: 'كلمة المرور',
  secretTitle: 'مطلوب سر',
  secretDesc: 'يحتاج الوكيل إلى بيانات اعتماد للمتابعة.',
  secretPlaceholder: 'القيمة السرية'
}
