// components/forms/HardwareRequirementsForm.tsx
import React from "react"
import {Label} from "@/components/ui/label"
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select"
import {Button} from "@/components/ui/button"
import {Textarea} from "@/components/ui/textarea"
import {Plus, Trash2, Cpu, Camera, Mic, Speaker, Wifi, RotateCw, CircleDot, Lightbulb} from "lucide-react"
import {HardwareType, HardwareRequirementLevel} from "../../types/enums"
import {HardwareRequirement} from "@mentra/sdk"

interface HardwareRequirementsFormProps {
  requirements: HardwareRequirement[]
  onChange: (requirements: HardwareRequirement[]) => void
}

const hardwareTypeIcons: Record<HardwareType, React.ReactNode> = {
  [HardwareType.CAMERA]: <Camera className="h-4 w-4" />,
  [HardwareType.DISPLAY]: <Cpu className="h-4 w-4" />,
  [HardwareType.MICROPHONE]: <Mic className="h-4 w-4" />,
  [HardwareType.SPEAKER]: <Speaker className="h-4 w-4" />,
  [HardwareType.IMU]: <RotateCw className="h-4 w-4" />,
  [HardwareType.BUTTON]: <CircleDot className="h-4 w-4" />,
  [HardwareType.LIGHT]: <Lightbulb className="h-4 w-4" />,
  [HardwareType.WIFI]: <Wifi className="h-4 w-4" />,
}

const hardwareTypeLabels: Record<HardwareType, string> = {
  [HardwareType.CAMERA]: "Camera",
  [HardwareType.DISPLAY]: "Display",
  [HardwareType.MICROPHONE]: "Microphone",
  [HardwareType.SPEAKER]: "Speaker",
  [HardwareType.IMU]: "IMU (Motion Sensors)",
  [HardwareType.BUTTON]: "Physical Button",
  [HardwareType.LIGHT]: "LED Light",
  [HardwareType.WIFI]: "WiFi",
}

/**
 * Individual hardware requirement item component with collapsed/expanded views
 */
interface HardwareRequirementItemProps {
  requirement: HardwareRequirement
  index: number
  isEditing: boolean
  onEditToggle: (index: number | null) => void
  removeRequirement: (index: number) => void
  updateRequirement: (index: number, field: keyof HardwareRequirement, value: string) => void
  availableTypes: HardwareType[]
}

const HardwareRequirementItem: React.FC<HardwareRequirementItemProps> = ({
  requirement,
  index,
  isEditing,
  onEditToggle,
  removeRequirement,
  updateRequirement,
  availableTypes,
}) => {
  // Helper function to get description preview
  const getDescriptionPreview = () => {
    if (requirement.description && requirement.description.trim()) {
      return requirement.description.length > 50
        ? requirement.description.substring(0, 50) + "..."
        : requirement.description
    }
    return "No description"
  }

  return (
    <div className="border rounded-lg bg-white shadow-sm">
      {!isEditing ? (
        // Collapsed view - just show the essential info
        <div className="p-4 cursor-pointer hover:bg-gray-50 transition-colors" onClick={() => onEditToggle(index)}>
          <div className="flex items-center gap-3">
            {/* Content preview */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                {hardwareTypeIcons[requirement.type as HardwareType]}
                <span className="font-medium text-sm text-gray-900">
                  {hardwareTypeLabels[requirement.type as HardwareType]}
                </span>
                <span
                  className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                    requirement.level === HardwareRequirementLevel.REQUIRED
                      ? "bg-gray-100 text-gray-800"
                      : "bg-gray-100 text-gray-800"
                  }`}>
                  {requirement.level === HardwareRequirementLevel.REQUIRED ? "Required" : "Optional"}
                </span>
              </div>
              <div className="text-xs text-gray-500 truncate">{getDescriptionPreview()}</div>
            </div>

            {/* Delete button */}
            <Button
              onClick={(e) => {
                e.stopPropagation()
                removeRequirement(index)
              }}
              variant="ghost"
              size="sm"
              type="button"
              className="h-8 w-8 p-0 text-red-600 hover:text-red-700">
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
              {hardwareTypeIcons[requirement.type as HardwareType]}
              Edit Hardware Requirement
            </h4>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => onEditToggle(null)}
                variant="outline"
                size="sm"
                type="button"
                className="h-8 px-3 text-xs">
                Done
              </Button>
              <Button
                onClick={() => removeRequirement(index)}
                variant="ghost"
                size="sm"
                type="button"
                className="h-8 w-8 p-0 text-red-600 hover:text-red-700">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Form fields */}
          <div className="space-y-4">
            {/* Hardware Type */}
            <div>
              <Label className="text-sm font-medium">Hardware Type</Label>
              <Select value={requirement.type} onValueChange={(value) => updateRequirement(index, "type", value)}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select hardware type" />
                </SelectTrigger>
                <SelectContent>
                  {/* Available types for new/existing requirements */}
                  {availableTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      <div className="flex items-center gap-2">
                        {hardwareTypeIcons[type]}
                        <span>{hardwareTypeLabels[type]}</span>
                      </div>
                    </SelectItem>
                  ))}

                  {/* Current type (if not in available types) */}
                  {!availableTypes.includes(requirement.type) && (
                    <SelectItem value={requirement.type}>
                      <div className="flex items-center gap-2">
                        {hardwareTypeIcons[requirement.type as HardwareType]}
                        <span>{hardwareTypeLabels[requirement.type as HardwareType]}</span>
                      </div>
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Requirement Level */}
            <div>
              <Label className="text-sm font-medium">Requirement Level</Label>
              <Select value={requirement.level} onValueChange={(value) => updateRequirement(index, "level", value)}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select requirement level" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={HardwareRequirementLevel.REQUIRED}>
                    <span className="text-gray-900">Required</span>
                  </SelectItem>
                  <SelectItem value={HardwareRequirementLevel.OPTIONAL}>
                    <span className="text-gray-900">Optional</span>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500 mt-1">
                Required hardware will prevent app installation if not available
              </p>
            </div>

            {/* Description */}
            <div>
              <Label className="text-sm font-medium">Description (Optional)</Label>
              <Textarea
                value={requirement.description || ""}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  updateRequirement(index, "description", e.target.value)
                }
                placeholder="Explain why this hardware is needed (e.g., 'Camera is required for QR code scanning')"
                rows={3}
                className="mt-1"
              />
              <p className="text-xs text-gray-500 mt-1">
                A clear explanation helps users understand why this hardware is necessary.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Hardware requirements form component with mobile-friendly design
 */
const HardwareRequirementsForm: React.FC<HardwareRequirementsFormProps> = ({requirements, onChange}) => {
  const [editingIndex, setEditingIndex] = React.useState<number | null>(null)

  // Helper function to create a new empty requirement
  const createEmptyRequirement = (type: HardwareType): HardwareRequirement => ({
    type,
    level: HardwareRequirementLevel.REQUIRED,
    description: "",
  })

  // Get available hardware types for NEW requirement selection
  const getAvailableHardwareTypes = (excludeIndex?: number): HardwareType[] => {
    return Object.values(HardwareType).filter((type) => {
      // Exclude already used hardware types
      return !requirements.some((req, i) => req.type === type && i !== excludeIndex)
    })
  }

  // Add a new requirement
  const addRequirement = () => {
    const availableTypes = getAvailableHardwareTypes()

    // If all hardware types are used, don't add a new one
    if (availableTypes.length === 0) {
      return
    }

    const newRequirement = createEmptyRequirement(availableTypes[0])
    const newRequirements = [...requirements, newRequirement]
    onChange(newRequirements)
    // Auto-expand the newly added requirement for editing
    setEditingIndex(newRequirements.length - 1)
  }

  // Remove a requirement
  const removeRequirement = (index: number) => {
    const newRequirements = requirements.filter((_, i) => i !== index)
    onChange(newRequirements)
    // If we're removing the currently editing item, clear the editing state
    if (editingIndex === index) {
      setEditingIndex(null)
    } else if (editingIndex !== null && editingIndex > index) {
      // If we're removing an item before the currently editing one, adjust the index
      setEditingIndex(editingIndex - 1)
    }
  }

  // Update a requirement
  const updateRequirement = (index: number, field: keyof HardwareRequirement, value: string) => {
    const updatedRequirements = [...requirements]
    updatedRequirements[index] = {
      ...updatedRequirements[index],
      [field]: value,
    }
    onChange(updatedRequirements)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-lg font-medium flex items-center gap-2">
            <Cpu className="h-5 w-5" />
            Hardware Requirements
          </h3>
          <p className="text-sm text-gray-600">Specify hardware components your app needs to function properly.</p>
        </div>
        <Button
          onClick={addRequirement}
          size="sm"
          type="button"
          className="h-8 px-3"
          disabled={getAvailableHardwareTypes().length === 0}>
          <Plus className="h-4 w-4 mr-1" />
          {getAvailableHardwareTypes().length === 0 ? "All Added" : "Add Hardware"}
        </Button>
      </div>

      {requirements.length === 0 ? (
        <div className="text-center py-4 text-gray-500">
          <p>No hardware requirements specified.</p>
          <p className="text-xs mt-1">The app will be assumed to work with any hardware.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {requirements.map((requirement, index) => (
            <HardwareRequirementItem
              key={index}
              requirement={requirement}
              index={index}
              isEditing={editingIndex === index}
              onEditToggle={setEditingIndex}
              removeRequirement={removeRequirement}
              updateRequirement={updateRequirement}
              availableTypes={getAvailableHardwareTypes(index)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default HardwareRequirementsForm
