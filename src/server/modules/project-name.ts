// 项目身份只去除首尾空白；大小写及 Unicode 写法不合并。
export function projectNameKey(name: string) {
  const value = name.trim();
  if (!value || Array.from(value).length > 255 || !value.isWellFormed()) {
    throw Object.assign(new Error('项目名称不能为空或超过255字'), { code: 'INVALID_PROJECT_NAME', status: 422 });
  }
  return Buffer.from(value, 'utf8');
}
