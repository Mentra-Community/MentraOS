import React from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Trash2, Brain, ChevronDown, ChevronRight, Settings, GripVertical } from "lucide-react";
import { Tool } from '@/types/tpa';

interface ToolsEditorProps {
  tools: Tool[];
  onChange: (tools: Tool[]) => void;
  className?: string;
}

// Internal parameter representation for editing
interface InternalParameter {
  id: string;
  key: string;
  type: string;
  description: string;
  required: boolean;
  enum?: string[];
  enumRaw?: string;
}

// Internal tool representation for editing
interface InternalTool {
  id: string;
  description: string;
  activationPhrases: string[];
  activationPhrasesRaw?: string;
  parameters: InternalParameter[];
}

/**
 * Convert SDK tool format to internal editing format
 */
const convertToolToInternal = (tool: any): InternalTool => {
  const parameters: InternalParameter[] = [];

  if (tool.parameters && typeof tool.parameters === 'object') {
    Object.entries(tool.parameters).forEach(([key, param]: [string, any]) => {
      parameters.push({
        id: `param_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        key,
        type: param.type || 'string',
        description: param.description || '',
        required: param.required || false,
        enum: param.enum,
        enumRaw: param.enumRaw
      });
    });
  }

  return {
    id: tool.id || '',
    description: tool.description || '',
    activationPhrases: tool.activationPhrases || [],
    activationPhrasesRaw: tool.activationPhrasesRaw,
    parameters
  };
};

/**
 * Convert internal editing format to SDK tool format
 */
const convertToolToSDK = (internalTool: InternalTool): any => {
  const parameters: { [key: string]: any } = {};

  internalTool.parameters.forEach(param => {
    parameters[param.key] = {
      type: param.type,
      description: param.description,
      required: param.required,
      ...(param.enum && param.enum.length > 0 ? { enum: param.enum } : {})
    };
  });

  return {
    id: internalTool.id,
    description: internalTool.description,
    activationPhrases: internalTool.activationPhrases,
    parameters
  };
};

/**
 * Compact tool item component with mobile-friendly expandable editing
 */
interface ToolItemProps {
  tool: InternalTool;
  index: number;
  isEditing: boolean;
  onEditToggle: (index: number | null) => void;
  removeTool: (index: number) => void;
  updateTool: (index: number, updates: Partial<InternalTool>) => void;
  updateActivationPhrasesRaw: (index: number, value: string) => void;
  parseActivationPhrases: (index: number, value: string) => void;
  addParameter: (toolIndex: number) => void;
  removeParameter: (toolIndex: number, paramId: string) => void;
  updateParameter: (toolIndex: number, paramId: string, updates: Partial<InternalParameter>) => void;
}

const ToolItem: React.FC<ToolItemProps> = ({
  tool,
  index,
  isEditing,
  onEditToggle,
  removeTool,
  updateTool,
  updateActivationPhrasesRaw,
  parseActivationPhrases,
  addParameter,
  removeParameter,
  updateParameter,
}) => {
  // Helper function to get display text
  const getDisplayText = () => {
    return tool.id || 'untitled_tool';
  };

  // Helper function to get parameter count
  const getParameterCount = () => {
    return tool.parameters.length;
  };

  // Helper function to get activation phrases preview
  const getActivationPhrasesPreview = () => {
    const phrases = tool.activationPhrases || [];
    if (phrases.length === 0) return 'No phrases';
    if (phrases.length <= 2) return phrases.join(', ');
    return `${phrases.slice(0, 2).join(', ')}, +${phrases.length - 2} more`;
  };

  // Helper function to get the raw activation phrases string for editing
  const getActivationPhrasesString = () => {
    // If we have a raw string stored, use that for editing
    if (tool.activationPhrasesRaw !== undefined) {
      return tool.activationPhrasesRaw;
    }
    // Otherwise, convert the array back to a string
    return (tool.activationPhrases || []).join(', ');
  };

  return (
    <div className="border rounded-lg bg-white shadow-sm">
      {!isEditing ? (
        // Collapsed view - just show the essential info
        <div
          className="p-4 cursor-pointer hover:bg-gray-50 transition-colors"
          onClick={() => onEditToggle(index)}
        >
          <div className="flex items-center gap-3">
            {/* Content preview */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Brain className="h-4 w-4 text-blue-600 flex-shrink-0" />
                <span className="font-medium text-sm text-gray-900 truncate">
                  {getDisplayText()}
                </span>
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                  {getParameterCount()} params
                </span>
              </div>
              <div className="flex flex-col gap-1 text-xs text-gray-500">
                <span className="truncate">
                  {tool.description || 'No description'}
                </span>
                <span className="truncate">
                  Phrases: {getActivationPhrasesPreview()}
                </span>
              </div>
            </div>

            {/* Delete button */}
            <Button
              onClick={(e) => {
                e.stopPropagation();
                removeTool(index);
              }}
              variant="ghost"
              size="sm"
              type="button"
              className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        // Expanded editing view
        <div className="p-4">
          {/* Header with close button */}
          <div className="flex items-center justify-between mb-4">
            <h4 className="font-medium text-sm flex items-center gap-2">
              <Brain className="h-4 w-4" />
              Edit AI Tool
            </h4>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => onEditToggle(null)}
                variant="outline"
                size="sm"
                type="button"
                className="h-8 px-3 text-xs"
              >
                Done
              </Button>
              <Button
                onClick={() => removeTool(index)}
                variant="ghost"
                size="sm"
                type="button"
                className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Form fields */}
          <div className="space-y-4">
            {/* Tool ID */}
            <div>
              <Label className="text-sm font-medium">Tool ID</Label>
              <Input
                value={tool.id || ''}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateTool(index, { id: e.target.value })}
                placeholder="e.g., search_notes"
                className="mt-1 font-mono"
              />
              <p className="text-xs text-gray-500 mt-1">
                Unique identifier (alphanumeric, no spaces)
              </p>
            </div>

            {/* Description */}
            <div>
              <Label className="text-sm font-medium">Description</Label>
              <Textarea
                value={tool.description || ''}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateTool(index, { description: e.target.value })}
                placeholder="Describe what this tool does..."
                rows={3}
                className="mt-1"
              />
              <p className="text-xs text-gray-500 mt-1">
                Clear description for the AI to understand
              </p>
            </div>

            {/* Activation Phrases */}
            <div>
              <Label className="text-sm font-medium">Activation Phrases</Label>
              <Input
                value={getActivationPhrasesString()}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateActivationPhrasesRaw(index, e.target.value)}
                onBlur={(e: React.FocusEvent<HTMLInputElement>) => parseActivationPhrases(index, e.target.value)}
                placeholder="search my notes, find information, look up"
                className="mt-1"
              />
              <p className="text-xs text-gray-500 mt-1">
                Comma-separated phrases that trigger this tool
              </p>
            </div>

            {/* Parameters */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <Label className="text-sm font-medium">Parameters</Label>
                <Button
                  onClick={() => addParameter(index)}
                  variant="outline"
                  size="sm"
                  type="button"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add Parameter
                </Button>
              </div>

              {tool.parameters.length === 0 ? (
                <div className="text-center py-6 text-gray-500 text-sm border-2 border-dashed rounded">
                  No parameters defined. Parameters allow the tool to receive additional data.
                </div>
              ) : (
                <div className="space-y-3">
                  {tool.parameters.map((param) => (
                    <div key={param.id} className="bg-gray-50 rounded-lg p-4 border">
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h5 className="font-medium text-sm">Parameter: {param.key}</h5>
                          <Button
                            onClick={() => removeParameter(index, param.id)}
                            variant="ghost"
                            size="sm"
                            type="button"
                            className="text-red-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs">Parameter Name</Label>
                            <Input
                              value={param.key}
                              onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateParameter(index, param.id, { key: e.target.value })}
                              placeholder="parameter_name"
                              className="mt-1 font-mono"
                            />
                          </div>
                          <div>
                            <Label className="text-xs">Type</Label>
                            <Select
                              value={param.type || 'string'}
                              onValueChange={(value) => updateParameter(index, param.id, { type: value })}
                            >
                              <SelectTrigger className="mt-1">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="string">String</SelectItem>
                                <SelectItem value="number">Number</SelectItem>
                                <SelectItem value="boolean">Boolean</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <div>
                          <Label className="text-xs">Description</Label>
                          <Textarea
                            value={param.description || ''}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateParameter(index, param.id, { description: e.target.value })}
                            placeholder="Describe this parameter..."
                            rows={2}
                            className="mt-1"
                          />
                        </div>

                        <div className="flex items-start gap-4">
                          <div className="flex items-center space-x-2">
                            <Checkbox
                              checked={param.required || false}
                              onCheckedChange={(checked) => updateParameter(index, param.id, { required: checked as boolean })}
                            />
                            <Label className="text-xs">Required parameter</Label>
                          </div>

                          {param.type === 'string' && (
                            <div className="flex-1">
                              <Label className="text-xs">Enum Values (optional)</Label>
                              <Input
                                value={param.enumRaw !== undefined ? param.enumRaw : (param.enum || []).join(', ')}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                  updateParameter(index, param.id, { enumRaw: e.target.value });
                                }}
                                onBlur={(e: React.FocusEvent<HTMLInputElement>) => {
                                  const enumValues = e.target.value.split(',').map((v: string) => v.trim()).filter((v: string) => v.length > 0);
                                  updateParameter(index, param.id, {
                                    enum: enumValues.length > 0 ? enumValues : undefined,
                                    enumRaw: undefined
                                  });
                                }}
                                placeholder="option1, option2, option3"
                                className="mt-1"
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Compact tools editor component with mobile-friendly design
 */
const ToolsEditor: React.FC<ToolsEditorProps> = ({ tools, onChange, className }) => {
  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);

  // Convert tools to internal format for editing (only initialize once)
  const [internalTools, setInternalTools] = React.useState<InternalTool[]>(() =>
    tools.map(convertToolToInternal)
  );

  // Helper function to create a new empty tool
  const createEmptyTool = (): InternalTool => ({
    id: '',
    description: '',
    activationPhrases: [],
    parameters: []
  });

  // Helper function to update external tools from internal tools
  const updateExternalTools = (newInternalTools: InternalTool[]) => {
    setInternalTools(newInternalTools);
    const externalTools = newInternalTools.map(convertToolToSDK);
    onChange(externalTools);
  };

  // Add a new tool
  const addTool = () => {
    const newTool = createEmptyTool();
    const newInternalTools = [...internalTools, newTool];
    updateExternalTools(newInternalTools);
    // Auto-expand the newly added tool for editing
    setEditingIndex(newInternalTools.length - 1);
  };

  // Remove a tool
  const removeTool = (index: number) => {
    const newInternalTools = internalTools.filter((_, i) => i !== index);
    updateExternalTools(newInternalTools);
    // If we're removing the currently editing item, clear the editing state
    if (editingIndex === index) {
      setEditingIndex(null);
    } else if (editingIndex !== null && editingIndex > index) {
      // If we're removing an item before the currently editing one, adjust the index
      setEditingIndex(editingIndex - 1);
    }
  };

  // Update a tool
  const updateTool = (index: number, updates: Partial<InternalTool>) => {
    const newInternalTools = [...internalTools];
    newInternalTools[index] = { ...newInternalTools[index], ...updates };
    updateExternalTools(newInternalTools);
  };

  // Handle activation phrases (comma-separated string to array)
  const updateActivationPhrasesRaw = (index: number, value: string) => {
    // Store the raw string value for editing
    updateTool(index, { activationPhrasesRaw: value });
  };

  // Parse activation phrases (string to array)
  const parseActivationPhrases = (index: number, value: string) => {
    const phrases = value.split(',').map(phrase => phrase.trim()).filter(phrase => phrase.length > 0);
    updateTool(index, { activationPhrases: phrases, activationPhrasesRaw: undefined });
  };

  // Add parameter to a tool
  const addParameter = (toolIndex: number) => {
    const tool = internalTools[toolIndex];
    const newParameter: InternalParameter = {
      id: `param_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      key: `param${tool.parameters.length + 1}`,
      type: 'string',
      description: '',
      required: false
    };

    const newParameters = [...tool.parameters, newParameter];
    updateTool(toolIndex, { parameters: newParameters });
  };

  // Remove parameter from a tool
  const removeParameter = (toolIndex: number, paramId: string) => {
    const tool = internalTools[toolIndex];
    const newParameters = tool.parameters.filter(param => param.id !== paramId);
    updateTool(toolIndex, { parameters: newParameters });
  };

  // Update parameter
  const updateParameter = (toolIndex: number, paramId: string, updates: Partial<InternalParameter>) => {
    const tool = internalTools[toolIndex];
    const newParameters = tool.parameters.map(param =>
      param.id === paramId ? { ...param, ...updates } : param
    );
    updateTool(toolIndex, { parameters: newParameters });
  };

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-lg font-medium flex items-center gap-2">
            <Brain className="h-5 w-5" />
            AI Tools
          </h3>
          <p className="text-sm text-gray-600">
            Define AI tools for voice interactions
          </p>
        </div>
        <Button
          onClick={addTool}
          size="sm"
          type="button"
          className="h-8 px-3"
        >
          <Plus className="h-4 w-4 mr-1" />
          Add Tool
        </Button>
      </div>

      {internalTools.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          <Brain className="h-12 w-12 mx-auto mb-2 opacity-50" />
          <p>No AI tools defined yet.</p>
          <p className="text-sm">Add your first tool to enable AI interactions.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {internalTools.map((tool, index) => (
            <ToolItem
              key={tool.id || `tool-${index}`}
              tool={tool}
              index={index}
              isEditing={editingIndex === index}
              onEditToggle={setEditingIndex}
              removeTool={removeTool}
              updateTool={updateTool}
              updateActivationPhrasesRaw={updateActivationPhrasesRaw}
              parseActivationPhrases={parseActivationPhrases}
              addParameter={addParameter}
              removeParameter={removeParameter}
              updateParameter={updateParameter}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default ToolsEditor;