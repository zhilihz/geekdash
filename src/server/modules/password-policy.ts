export const passwordHint='至少8个字符，数字、大写字母、小写字母、特殊字符中至少包含两类。';
export function validPassword(value:unknown):value is string {
 return typeof value==='string' && !/[\uD800-\uDFFF]/u.test(value) && [...value].length>=8 && [...value].length<=128 && [/[0-9]/,/[A-Z]/,/[a-z]/,/[\p{P}\p{S}]/u].filter(rule=>rule.test(value)).length>=2;
}
