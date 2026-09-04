export function validatePassword(password, account, label = '密码') {
  const value = password == null ? '' : String(password);
  if (!value) return `${label}不能为空。`;
  if (value.length < 6 || value.length > 32) return `${label}长度必须在6到32位之间。`;
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  const hasSpecial = /[^A-Za-z0-9]/.test(value);
  if (!hasUpper || !hasLower || !hasDigit || !hasSpecial) {
    return `${label}需为6至32位，并包含大写字母、小写字母、数字和特殊字符。`;
  }
  if (account && value.toLowerCase().includes(String(account).toLowerCase())) {
    return `${label}不能包含登录账号。`;
  }
  return '';
}

export function validateTemporaryPassword(password, account) {
  return validatePassword(password, account, '临时密码');
}
