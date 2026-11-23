export const defaultClaudeModel = 'claude-fable-5-2';
export const claudeModels = Object.freeze([defaultClaudeModel, 'claude-opus-4-6']);

export function requireClaudeModel(model) {
  if (!claudeModels.includes(model))
    throw Object.assign(new Error('Select a supported exact Claude model.'), { status: 400 });
  return model;
}
