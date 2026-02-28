// components/forms/SettingsEditor.tsx
import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus,
  Trash2,
  GripVertical,
  ChevronDown,
  ChevronRight,
  Settings,
  Folder,
} from "lucide-react";
import { Setting } from "@/types/app";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export enum AppSettingType {
  TOGGLE = "toggle",
  TEXT = "text",
  SELECT = "select",
  SLIDER = "slider",
  GROUP = "group",
  TEXT_NO_SAVE_BUTTON = "text_no_save_button",
  SELECT_WITH_SEARCH = "select_with_search",
  MULTISELECT = "multiselect",
  TITLE_VALUE = "titleValue",
  NUMERIC_INPUT = "numeric_input",
  TIME_PICKER = "time_picker",
}

interface SettingsEditorProps {
  settings: Setting[];
  onChange: (settings: Setting[]) => void;
  className?: string;
  setSameValueWarning: (value: boolean) => void;
  toast: typeof import("sonner").toast;
}

/**
 * Compact sortable setting item component
 */
interface SortableSettingItemProps {
  setting: any;
  index: number;
  id: string;
  isEditing: boolean;
  onEditToggle: (index: number | null) => void;
  removeSetting: (index: number) => void;
  updateSetting: (index: number, updates: any) => void;
  handleTypeChange: (index: number, newType: string) => void;
  updateSelectOptions: (
    settingIndex: number,
    optionIndex: number,
    field: "label" | "value",
    value: string,
  ) => void;
  addSelectOption: (settingIndex: number) => void;
  removeSelectOption: (settingIndex: number, optionIndex: number) => void;
  toast: typeof import("sonner").toast;
  setSameValueWarning: (value: boolean) => void;
}
const specialSettings = ["multiselect", "select"]

const SortableSettingItem: React.FC<SortableSettingItemProps> = ({
  setting,
  index,
  id,
  isEditing,
  onEditToggle,
  removeSetting,
  updateSetting,
  handleTypeChange,
  updateSelectOptions,
  addSelectOption,
  removeSelectOption,
  toast,
  setSameValueWarning,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isGroup = setting.type === AppSettingType.GROUP;

  // Auto-expand when SELECT type is chosen and has empty options
  React.useEffect(() => {
    if (
      setting.type === AppSettingType.SELECT &&
      (!setting.options || setting.options.length === 0)
    ) {
      onEditToggle(index);
    }
  }, [setting.type, setting.options, index, onEditToggle]);

  // Helper function to get display text
  const getDisplayText = () => {
    if (isGroup) {
      return setting.title || "Untitled Group";
    }
    return setting.key || setting.label || setting.title || "untitled_setting";
  };

  // Helper function to get display label
  const getDisplayLabel = () => {
    if (isGroup) return null;
    return setting.label || "No label";
  };

  // Helper function to get default value preview
  const getDefaultValuePreview = () => {
    switch (setting.type) {
      case AppSettingType.TOGGLE:
        return setting.defaultValue ? "✓ Enabled" : "✗ Disabled";
      case AppSettingType.TEXT:
      case AppSettingType.TEXT_NO_SAVE_BUTTON:
        return setting.defaultValue || "No default";
      case AppSettingType.SELECT:
      case AppSettingType.SELECT_WITH_SEARCH:
        const selectedOption = (setting.options || []).find(
          (opt: any) => opt.value === setting.defaultValue,
        );
        return selectedOption ? selectedOption.label : "No default";
      case AppSettingType.MULTISELECT:
        const selectedOptions = (setting.options || []).filter(
          (opt: any) =>
            Array.isArray(setting.defaultValue) &&
            setting.defaultValue.includes(opt.value),
        );
        return selectedOptions.length > 0
          ? `${selectedOptions.length} selected`
          : "No default";
      case AppSettingType.SLIDER:
        return `${setting.defaultValue || 0} (${setting.min || 0}-${setting.max || 100})`;
      case AppSettingType.NUMERIC_INPUT:
        const minText = setting.min !== undefined ? `min: ${setting.min}` : "";
        const maxText = setting.max !== undefined ? `max: ${setting.max}` : "";
        const rangeText = [minText, maxText].filter(Boolean).join(", ");
        return `${setting.defaultValue || 0}${rangeText ? ` (${rangeText})` : ""}`;
      case AppSettingType.TIME_PICKER:
        const totalSeconds = setting.defaultValue || 0;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const timeStr = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
        return `${timeStr} (${totalSeconds}s)`;
      case AppSettingType.TITLE_VALUE:
        return setting.value ? String(setting.value) : "No value";
      default:
        return "";
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border rounded-lg bg-white shadow-sm"
    >
      {!isEditing ? (
        // Collapsed view - just show the essential info
        <div
          className="p-4 cursor-pointer hover:bg-gray-50 transition-colors"
          onClick={() => onEditToggle(index)}
        >
          <div className="flex items-center gap-3">
            {/* Drag handle */}
            <button
              className="cursor-grab hover:bg-gray-200 rounded p-1 -ml-1"
              {...attributes}
              {...listeners}
              type="button"
              onClick={(e) => e.stopPropagation()}
            >
              <GripVertical className="h-4 w-4 text-gray-400" />
            </button>

            {/* Content preview */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                  {setting.type}
                </span>
                <span className="font-medium text-sm text-gray-900 truncate">
                  {getDisplayText()}
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs text-gray-500">
                {!isGroup && (
                  <>
                    <span>Label: {getDisplayLabel()}</span>
                    <span>Default: {getDefaultValuePreview()}</span>
                  </>
                )}
              </div>
            </div>

            {/* Delete button */}
            <Button
              onClick={(e) => {
                e.stopPropagation();
                removeSetting(index);
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
            <h4 className="font-medium text-sm">
              {isGroup ? "Edit Group" : "Edit Setting"}
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
                onClick={() => removeSetting(index)}
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
            {/* Type selector */}
            <div>
              <Label className="text-sm font-medium">Type</Label>
              <Select
                value={setting.type}
                onValueChange={(value) => handleTypeChange(index, value)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AppSettingType.GROUP}>Group</SelectItem>
                  <SelectItem value={AppSettingType.TOGGLE}>Toggle</SelectItem>
                  <SelectItem value={AppSettingType.TEXT}>Text</SelectItem>
                  <SelectItem value={AppSettingType.TEXT_NO_SAVE_BUTTON}>
                    Text (No Save)
                  </SelectItem>
                  <SelectItem value={AppSettingType.SELECT}>Select</SelectItem>
                  <SelectItem value={AppSettingType.SELECT_WITH_SEARCH}>
                    Select with Search
                  </SelectItem>
                  <SelectItem value={AppSettingType.MULTISELECT}>
                    Multiselect
                  </SelectItem>
                  <SelectItem value={AppSettingType.SLIDER}>Slider</SelectItem>
                  <SelectItem value={AppSettingType.NUMERIC_INPUT}>
                    Numeric Input
                  </SelectItem>
                  <SelectItem value={AppSettingType.TIME_PICKER}>
                    Time Picker
                  </SelectItem>
                  <SelectItem value={AppSettingType.TITLE_VALUE}>
                    Title/Value Display
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {isGroup ? (
              /* Group fields */
              <div>
                <Label className="text-sm font-medium">Group Title</Label>
                <Input
                  value={setting.title || ""}
                  onChange={(e) =>
                    updateSetting(index, { title: e.target.value })
                  }
                  placeholder="e.g., Display Settings"
                  className="mt-1"
                />
              </div>
            ) : (
              /* Regular setting fields */
              <>
                {/* Setting Key - Hide for TITLE_VALUE type since they don't need keys */}
                {setting.type !== AppSettingType.TITLE_VALUE && (
                  <div>
                    <Label className="text-sm font-medium">Setting Key</Label>
                    <Input
                      value={setting.key || ""}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        updateSetting(index, { key: e.target.value })
                      }
                      placeholder="e.g., theme_color"
                      className="mt-1 font-mono"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Unique identifier (alphanumeric, no spaces)
                    </p>
                  </div>
                )}

                {/* Display Label */}
                <div>
                  <Label className="text-sm font-medium">Display Label</Label>
                  <Input
                    value={setting.label || ""}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      updateSetting(index, { label: e.currentTarget.value })
                    }
                    placeholder="e.g., Theme Color"
                    className="mt-1"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    This is the label for the setting that will be displayed to
                    the user
                  </p>
                </div>

                {/* Default Value - Type Specific */}
                {setting.type === AppSettingType.TOGGLE && (
                  <div>
                    <Label className="text-sm font-medium">Default Value</Label>
                    <div className="flex items-center space-x-2 mt-1">
                      <Checkbox
                        checked={setting.defaultValue}
                        onCheckedChange={(checked) =>
                          updateSetting(index, { defaultValue: checked })
                        }
                      />
                      <Label className="text-sm">Enabled by default</Label>
                    </div>
                  </div>
                )}

                {(setting.type === AppSettingType.TEXT ||
                  setting.type === AppSettingType.TEXT_NO_SAVE_BUTTON) && (
                  <div>
                    <Label className="text-sm font-medium">Default Value</Label>
                    <Input
                      value={setting.defaultValue || ""}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        updateSetting(index, {
                          defaultValue: e.currentTarget.value,
                        })
                      }
                      placeholder="Default text value"
                      className="mt-1"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      This is the default value for the setting if the user does
                      not provide a value
                    </p>
                    {setting.type === AppSettingType.TEXT_NO_SAVE_BUTTON && (
                      <div className="mt-2">
                        <Label className="text-sm font-medium">
                          Max Lines (optional)
                        </Label>
                        <Input
                          type="number"
                          value={setting.maxLines || ""}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updateSetting(index, {
                              maxLines:
                                parseInt(e.currentTarget.value) || undefined,
                            })
                          }
                          placeholder="e.g., 5"
                          className="mt-1"
                        />
                      </div>
                    )}
                  </div>
                )}

                {setting.type === AppSettingType.SLIDER && (
                  <div>
                    <Label className="text-sm font-medium">
                      Slider Configuration
                    </Label>
                    <div className="grid grid-cols-3 gap-3 mt-1">
                      <div>
                        <Label className="text-xs">Min</Label>
                        <Input
                          type="number"
                          value={setting.min || 0}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updateSetting(index, {
                              min: parseInt(e.currentTarget.value) || 0,
                            })
                          }
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Max</Label>
                        <Input
                          type="number"
                          value={setting.max || 100}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updateSetting(index, {
                              max: parseInt(e.currentTarget.value) || 100,
                            })
                          }
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Default</Label>
                        <Input
                          type="number"
                          value={setting.defaultValue || 0}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updateSetting(index, {
                              defaultValue:
                                parseInt(e.currentTarget.value) || 0,
                            })
                          }
                          className="mt-1"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {setting.type === AppSettingType.NUMERIC_INPUT && (
                  <div>
                    <Label className="text-sm font-medium">
                      Numeric Input Configuration
                    </Label>
                    <div className="grid grid-cols-2 gap-3 mt-1">
                      <div>
                        <Label className="text-xs">Min Value (optional)</Label>
                        <Input
                          type="number"
                          value={setting.min || ""}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updateSetting(index, {
                              min: e.currentTarget.value
                                ? parseInt(e.currentTarget.value)
                                : undefined,
                            })
                          }
                          placeholder="No minimum"
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Max Value (optional)</Label>
                        <Input
                          type="number"
                          value={setting.max || ""}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updateSetting(index, {
                              max: e.currentTarget.value
                                ? parseInt(e.currentTarget.value)
                                : undefined,
                            })
                          }
                          placeholder="No maximum"
                          className="mt-1"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 mt-2">
                      <div>
                        <Label className="text-xs">Step (optional)</Label>
                        <Input
                          type="number"
                          value={setting.step || ""}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updateSetting(index, {
                              step: e.currentTarget.value
                                ? parseInt(e.currentTarget.value)
                                : undefined,
                            })
                          }
                          placeholder="1"
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Default Value</Label>
                        <Input
                          type="number"
                          value={setting.defaultValue || ""}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updateSetting(index, {
                              defaultValue: e.currentTarget.value
                                ? parseInt(e.currentTarget.value)
                                : 0,
                            })
                          }
                          placeholder="0"
                          className="mt-1"
                        />
                      </div>
                    </div>
                    <div className="mt-2">
                      <Label className="text-xs">Placeholder (optional)</Label>
                      <Input
                        value={setting.placeholder || ""}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          updateSetting(index, {
                            placeholder: e.currentTarget.value,
                          })
                        }
                        placeholder="e.g., Enter a number"
                        className="mt-1"
                      />
                    </div>
                  </div>
                )}

                {setting.type === AppSettingType.TIME_PICKER && (
                  <div>
                    <Label className="text-sm font-medium">
                      Time Picker Configuration
                    </Label>
                    <div className="grid grid-cols-2 gap-3 mt-1">
                      <div>
                        <Label className="text-xs">
                          Default Value (seconds)
                        </Label>
                        <Input
                          type="number"
                          value={setting.defaultValue || 0}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updateSetting(index, {
                              defaultValue:
                                parseInt(e.currentTarget.value) || 0,
                            })
                          }
                          placeholder="0"
                          className="mt-1"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Total seconds (e.g., 3661 = 1:01:01)
                        </p>
                      </div>
                      <div>
                        <Label className="text-xs">Show Seconds</Label>
                        <div className="flex items-center space-x-2 mt-1">
                          <Checkbox
                            checked={setting.showSeconds !== false}
                            onCheckedChange={(checked) =>
                              updateSetting(index, { showSeconds: checked })
                            }
                          />
                          <Label className="text-sm">
                            Include seconds picker
                          </Label>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {(setting.type === AppSettingType.SELECT ||
                  setting.type === AppSettingType.SELECT_WITH_SEARCH ||
                  setting.type === AppSettingType.MULTISELECT) && (
                  <div>
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Options</Label>
                      <Button
                        onClick={() => addSelectOption(index)}
                        variant="outline"
                        size="sm"
                        type="button"
                      >
                        <Plus className="h-4 w-4 mr-1" />
                        Add Option
                      </Button>
                    </div>
                    <div className="space-y-2 mt-2">
                      {(setting.options || []).map(
                        (option: any, optionIndex: number) => (
                          <div
                            key={optionIndex}
                            className="flex items-center gap-2"
                          >
                            <Input
                              placeholder="Display label"
                              value={option.label}
                              onChange={(
                                e: React.ChangeEvent<HTMLInputElement>,
                              ) =>
                                updateSelectOptions(
                                  index,
                                  optionIndex,
                                  "label",
                                  e.currentTarget.value,
                                )
                              }
                              className="flex-1"
                            />
                            {/* right here boss */}
                            <Input
                              placeholder="Value"
                              value={option.value}
                              onChange={(
                                e: React.ChangeEvent<HTMLInputElement>,
                              ) => {
                                const newValue = e.currentTarget.value;
                                
                                // Check for conflicts and show toast if needed
                                if (specialSettings.includes(newValue)) {
                                  toast?.error("Warning: This is a reserved setting type!");
                                  setSameValueWarning(false);
                                } else if (setting.options && 
                                          setting.options.filter((_: any, idx: number) => idx !== optionIndex)
                                            .some((otherOpt: any) => otherOpt.value === newValue)) {
                                  toast?.error("Warning: Duplicate option value!");
                                  setSameValueWarning(true);
                                  
                                }
                                else {
                                  setSameValueWarning(false);
                                } 
                                
                                
                                updateSelectOptions(
                                  index,
                                  optionIndex,
                                  "value",
                                  newValue,
                                );
                              }}
                              className={`flex-1 font-mono ${
                                specialSettings.includes(option.value) ||
                                (setting.options && 
                                 setting.options.filter((_: any, idx: number) => idx !== optionIndex)
                                   .some((otherOpt: any) => otherOpt.value === option.value))
                                  ? "text-red-500"
                                  : ""
                              }`}
                            />
                            <Button
                              onClick={() =>
                                removeSelectOption(index, optionIndex)
                              }
                              variant="ghost"
                              size="sm"
                              type="button"
                              className="text-red-600"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ),
                      )}
                    </div>

                    {/* Only show default selection for single-select types, not multiselect */}
                    {(setting.type === AppSettingType.SELECT ||
                      setting.type === AppSettingType.SELECT_WITH_SEARCH) && (
                      <div className="mt-3">
                        <Label className="text-sm font-medium">
                          Default Selection
                        </Label>
                        <Select
                          value={setting.defaultValue || ""}
                          onValueChange={(value) =>
                            updateSetting(index, { defaultValue: value })
                          }
                        >
                          <SelectTrigger className="mt-1">
                            <SelectValue placeholder="Choose default option" />
                          </SelectTrigger>
                          <SelectContent>
                            {(setting.options || [])
                              .filter(
                                (option: any) =>
                                  option.value && option.value.trim() !== "",
                              )
                              .map((option: any, optionIndex: number) => (
                                <SelectItem
                                  key={optionIndex}
                                  value={option.value}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* For multiselect, show a different interface for default values */}
                    {setting.type === AppSettingType.MULTISELECT && (
                      <div className="mt-3">
                        <Label className="text-sm font-medium">
                          Default Selections
                        </Label>
                        <div className="space-y-2 mt-2">
                          {(setting.options || [])
                            .filter(
                              (option: any) =>
                                option.value && option.value.trim() !== "",
                            )
                            .map((option: any, optionIndex: number) => {
                              const isSelected =
                                Array.isArray(setting.defaultValue) &&
                                setting.defaultValue.includes(option.value);
                              return (
                                <div
                                  key={optionIndex}
                                  className="flex items-center space-x-2"
                                >
                                  <Checkbox
                                    checked={isSelected}
                                    onCheckedChange={(checked) => {
                                      const currentDefaults = Array.isArray(
                                        setting.defaultValue,
                                      )
                                        ? setting.defaultValue
                                        : [];
                                      let newDefaults;
                                      if (checked) {
                                        newDefaults = [
                                          ...currentDefaults,
                                          option.value,
                                        ];
                                      } else {
                                        newDefaults = currentDefaults.filter(
                                          (val: any) => val !== option.value,
                                        );
                                      }
                                      updateSetting(index, {
                                        defaultValue: newDefaults,
                                      });
                                    }}
                                  />
                                  <Label className="text-sm">
                                    {option.label}
                                  </Label>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {setting.type === AppSettingType.TITLE_VALUE && (
                  <div>
                    <Label className="text-sm font-medium">Display Value</Label>
                    <Input
                      value={setting.value || ""}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        updateSetting(index, { value: e.currentTarget.value })
                      }
                      placeholder="Value to display"
                      className="mt-1"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      This setting displays a read-only label and value to users
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Compact settings editor component with drag-and-drop functionality
 */
const SettingsEditor: React.FC<SettingsEditorProps> = ({
  settings,
  onChange,
  className,
  setSameValueWarning,
  toast
}) => {
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);

  // Generate stable unique IDs for each setting
  const settingsWithIds = React.useMemo(
    () =>
      settings.map((setting, index) => ({
        ...setting,
        id: (setting as any).id || `setting-${index}`,
      })),
    [settings],
  );

  // Configure sensors for drag and drop
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Helper function to create a new empty setting
  const createEmptySetting = (): any => ({
    type: AppSettingType.TEXT,
    key: "",
    label: "",
    defaultValue: "",
    id: `setting-${Date.now()}-${Math.random()}`,
  });

  // Helper function to create a new empty group setting
  const createEmptyGroupSetting = (): any => ({
    type: AppSettingType.GROUP,
    title: "",
    id: `group-${Date.now()}-${Math.random()}`,
  });

  // Add a new setting
  const addSetting = (type: "setting" | "group" = "setting") => {
    const newSetting =
      type === "group" ? createEmptyGroupSetting() : createEmptySetting();
    const newSettings = [...settings, newSetting];
    onChange(newSettings);
    // Auto-expand the newly added setting for editing
    setEditingIndex(newSettings.length - 1);
  };

  // Remove a setting
  const removeSetting = (index: number) => {
    const newSettings = settings.filter((_, i) => i !== index);
    onChange(newSettings);
    // If we're removing the currently editing item, clear the editing state
    if (editingIndex === index) {
      setEditingIndex(null);
    } else if (editingIndex !== null && editingIndex > index) {
      // If we're removing an item before the currently editing one, adjust the index
      setEditingIndex(editingIndex - 1);
    }
  };

  // Update a setting
  const updateSetting = (index: number, updates: any) => {
    const newSettings = [...settings];
    newSettings[index] = { ...newSettings[index], ...updates };
    onChange(newSettings);
  };

  // Handle setting type change
  const handleTypeChange = (index: number, newType: string) => {
    const currentSetting = settings[index];
    const updates: any = { type: newType };

    // Type guard to check if setting has key and label properties
    const hasKeyAndLabel = (s: any): s is { key: string; label: string } => {
      return "key" in s && "label" in s;
    };

    // Preserve common fields that exist across most setting types
    if (hasKeyAndLabel(currentSetting)) {
      updates.key = currentSetting.key;
      updates.label = currentSetting.label;
    }

    // Handle type-specific fields and preserve what makes sense
    switch (newType) {
      case AppSettingType.TOGGLE:
        // Preserve defaultValue if it's boolean, otherwise set to false
        updates.defaultValue =
          typeof currentSetting.defaultValue === "boolean"
            ? currentSetting.defaultValue
            : false;
        break;

      case AppSettingType.TEXT:
      case AppSettingType.TEXT_NO_SAVE_BUTTON:
        // Preserve defaultValue if it's a string, otherwise set to empty
        updates.defaultValue =
          typeof currentSetting.defaultValue === "string"
            ? currentSetting.defaultValue
            : "";
        // Preserve maxLines for TEXT_NO_SAVE_BUTTON if it exists
        if (
          newType === AppSettingType.TEXT_NO_SAVE_BUTTON &&
          "maxLines" in currentSetting &&
          typeof (currentSetting as any).maxLines === "number"
        ) {
          updates.maxLines = (currentSetting as any).maxLines;
        }
        break;

      case AppSettingType.SELECT:
      case AppSettingType.SELECT_WITH_SEARCH:
        // Always preserve existing options if they exist
        if (
          "options" in currentSetting &&
          Array.isArray((currentSetting as any).options)
        ) {
          updates.options = (currentSetting as any).options;
          // Preserve defaultValue if it's a valid option value
          const validValues = (currentSetting as any).options.map(
            (opt: any) => opt.value,
          );
          if (validValues.includes(currentSetting.defaultValue)) {
            updates.defaultValue = currentSetting.defaultValue;
          } else {
            updates.defaultValue = "";
          }
        } else {
          updates.options = [
            { label: "Option Label 1", value: "option_value_1" },
          ];
          updates.defaultValue = "";
        }
        break;

      case AppSettingType.MULTISELECT:
        // Always preserve existing options if they exist
        if (
          "options" in currentSetting &&
          Array.isArray((currentSetting as any).options)
        ) {
          
          updates.options = (currentSetting as any).options;
          // Convert single defaultValue to array, or preserve if already array
          if (Array.isArray(currentSetting.defaultValue)) {
            // Filter to only include valid option values
            const validValues = (currentSetting as any).options.map(
              (opt: any) => opt.value,
            );
            updates.defaultValue = currentSetting.defaultValue.filter(
              (val: any) => validValues.includes(val),
            );
          } else if (
            currentSetting.defaultValue &&
            (currentSetting as any).options.some(
              (opt: any) => opt.value === currentSetting.defaultValue,
            )
          ) {
            // Convert single value to array if it's a valid option
            updates.defaultValue = [currentSetting.defaultValue];
          } else {
            updates.defaultValue = [];
          }
        } else {
          updates.options = [
            { label: "Option Label 1", value: "option_value_1" },
          ];
          updates.defaultValue = [];
        }
        break;

      case AppSettingType.SLIDER:
        // Preserve min, max if they exist and are numbers
        updates.min =
          "min" in currentSetting &&
          typeof (currentSetting as any).min === "number"
            ? (currentSetting as any).min
            : 0;
        updates.max =
          "max" in currentSetting &&
          typeof (currentSetting as any).max === "number"
            ? (currentSetting as any).max
            : 100;
        // Preserve defaultValue if it's a number within range
        if (
          typeof currentSetting.defaultValue === "number" &&
          currentSetting.defaultValue >= updates.min &&
          currentSetting.defaultValue <= updates.max
        ) {
          updates.defaultValue = currentSetting.defaultValue;
        } else {
          updates.defaultValue = updates.min;
        }
        break;

      case AppSettingType.NUMERIC_INPUT:
        // Preserve min, max, step if they exist and are numbers
        updates.min =
          "min" in currentSetting &&
          typeof (currentSetting as any).min === "number"
            ? (currentSetting as any).min
            : undefined;
        updates.max =
          "max" in currentSetting &&
          typeof (currentSetting as any).max === "number"
            ? (currentSetting as any).max
            : undefined;
        updates.step =
          "step" in currentSetting &&
          typeof (currentSetting as any).step === "number"
            ? (currentSetting as any).step
            : undefined;
        updates.placeholder =
          "placeholder" in currentSetting &&
          typeof (currentSetting as any).placeholder === "string"
            ? (currentSetting as any).placeholder
            : undefined;
        // Preserve defaultValue if it's a number
        updates.defaultValue =
          typeof currentSetting.defaultValue === "number"
            ? currentSetting.defaultValue
            : 0;
        break;

      case AppSettingType.TIME_PICKER:
        // Preserve showSeconds if it exists
        updates.showSeconds =
          "showSeconds" in currentSetting &&
          typeof (currentSetting as any).showSeconds === "boolean"
            ? (currentSetting as any).showSeconds
            : true;
        // Preserve defaultValue if it's a number (total seconds)
        updates.defaultValue =
          typeof currentSetting.defaultValue === "number"
            ? currentSetting.defaultValue
            : 0;
        break;

      case AppSettingType.GROUP:
        // For groups, preserve title if it exists, otherwise use label as title
        updates.title =
          ("title" in currentSetting && (currentSetting as any).title) ||
          ("label" in currentSetting && currentSetting.label) ||
          "";
        // Remove fields that don't apply to groups
        delete updates.key;
        delete updates.label;
        break;

      case AppSettingType.TITLE_VALUE:
        // Preserve value if it exists, otherwise use defaultValue
        updates.value =
          ("value" in currentSetting && (currentSetting as any).value) ||
          currentSetting.defaultValue ||
          "";
        break;
    }

    updateSetting(index, updates);
  };

  // Handle options change for select settings
  const updateSelectOptions = (
    settingIndex: number,
    optionIndex: number,
    field: "label" | "value",
    value: string,
  ) => {
    const setting: any = settings[settingIndex];
    if (
      (setting.type === AppSettingType.SELECT ||
        setting.type === AppSettingType.SELECT_WITH_SEARCH ||
        setting.type === AppSettingType.MULTISELECT) &&
      setting.options
    ) {
      const newOptions = [...setting.options];
      newOptions[optionIndex] = { ...newOptions[optionIndex], [field]: value };
      updateSetting(settingIndex, { options: newOptions });
    }
  };

  // Add option for select settings
  const addSelectOption = (settingIndex: number) => {
    const setting: any = settings[settingIndex];
    if (
      setting.type === AppSettingType.SELECT ||
      setting.type === AppSettingType.SELECT_WITH_SEARCH ||
      setting.type === AppSettingType.MULTISELECT
    ) {
      const optionCount = (setting.options || []).length + 1;
      const newOptions = [
        ...(setting.options || []),
        {
          label: `Option Label ${optionCount}`,
          value: `option_value_${optionCount}`,
        },
      ];
      updateSetting(settingIndex, { options: newOptions });
    }
  };

  // Remove option for select settings
  const removeSelectOption = (settingIndex: number, optionIndex: number) => {
    const setting: any = settings[settingIndex];
    if (
      (setting.type === AppSettingType.SELECT ||
        setting.type === AppSettingType.SELECT_WITH_SEARCH ||
        setting.type === AppSettingType.MULTISELECT) &&
      setting.options
    ) {
      const newOptions = setting.options.filter(
        (_: any, i: number) => i !== optionIndex,
      );
      updateSetting(settingIndex, { options: newOptions });
    }
  };

  // Handle drag start
  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  // Handle drag end
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (active.id !== over?.id) {
      const oldIndex = settingsWithIds.findIndex(
        (item) => item.id === active.id,
      );
      const newIndex = settingsWithIds.findIndex(
        (item) => item.id === over?.id,
      );

      if (oldIndex !== -1 && newIndex !== -1) {
        const newSettings = arrayMove(settings, oldIndex, newIndex);
        onChange(newSettings);
      }
    }

    setActiveId(null);
  };

  const activeIndex = activeId
    ? settingsWithIds.findIndex((item) => item.id === activeId)
    : -1;
  const activeSetting = activeIndex !== -1 ? settings[activeIndex] : null;

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-lg font-medium flex items-center gap-2">
            <Settings className="h-5 w-5" />
            App Settings
          </h3>
          <p className="text-sm text-gray-600">
            Configure user settings. Drag to reorder.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => addSetting("group")}
            variant="outline"
            size="sm"
            type="button"
            className="h-8 px-3"
          >
            <Folder className="h-4 w-4 mr-1" />
            Group
          </Button>
          <Button
            onClick={() => addSetting("setting")}
            size="sm"
            type="button"
            className="h-8 px-3"
          >
            <Plus className="h-4 w-4 mr-1" />
            Setting
          </Button>
        </div>
      </div>

      {settings.length === 0 ? (
        <div className="text-center py-4 text-gray-500">
          <p>No settings defined yet.</p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={settingsWithIds.map((item) => item.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-2">
              {settingsWithIds.map((setting: any, index) => (
                <SortableSettingItem
                  key={setting.id}
                  id={setting.id}
                  setting={setting}
                  index={index}
                  isEditing={editingIndex === index}
                  onEditToggle={setEditingIndex}
                  removeSetting={removeSetting}
                  updateSetting={updateSetting}
                  handleTypeChange={handleTypeChange}
                  updateSelectOptions={updateSelectOptions}
                  addSelectOption={addSelectOption}
                  removeSelectOption={removeSelectOption}
                  toast={toast}
                  setSameValueWarning={setSameValueWarning}
                />
              ))}
            </div>
          </SortableContext>
          <DragOverlay>
            {activeId && activeSetting ? (
              <div className="border rounded-lg bg-white shadow-xl p-3">
                <div className="flex items-center gap-2">
                  <GripVertical className="h-4 w-4 text-gray-400" />
                  <span className="text-sm font-medium">
                    {activeSetting.type === AppSettingType.GROUP
                      ? `Group: ${activeSetting.title || "Untitled"}`
                      : `Setting: ${activeSetting.key || "Untitled"}`}
                  </span>
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
};

export default SettingsEditor;
