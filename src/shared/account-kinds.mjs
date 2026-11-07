export const isCollegeAccount = account => account.kind === '529' || /529/.test(account.name);
