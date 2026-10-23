export function serviceVisible(state, user, service) {
  const grants = state.userGrants.filter(g => g.userId === user.id && g.serviceId === service.id && g.toolName === '*');
  if (grants.some(g => g.mode === 'deny')) return false;
  return service.marketplaceVisibility !== 'restricted' || user.groupId === 'admins' || service.marketplaceGroupIds?.includes(user.groupId) || grants.some(g => g.mode === 'allow');
}
export function toolAllowed(state, user, service, name) {
  if (service.status !== 'active' || service.marketplaceStatus !== 'published' || !serviceVisible(state, user, service) || !service.tools?.some(t => t.name === name)) return false;
  const matches = [...state.grants.filter(g => g.groupId === user.groupId), ...state.userGrants.filter(g => g.userId === user.id)].filter(g => g.serviceId === service.id && g.toolName === name);
  if (matches.some(g => g.mode === 'deny')) return false;
  return matches.some(g => g.mode === 'allow');
}
