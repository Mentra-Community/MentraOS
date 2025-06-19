import { ChevronRight, ChevronDown } from 'lucide-react';

interface StateTreeNodeProps {
  label: string;
  path: string;
  data: any;
  expandedNodes: Record<string, boolean>;
  toggleNode: (path: string) => void;
  depth?: number;
}

export function StateTreeNode({ 
  label, 
  path, 
  data, 
  expandedNodes, 
  toggleNode, 
  depth = 0 
}: StateTreeNodeProps) {
  const isExpanded = expandedNodes[path];
  const isObject = data && typeof data === 'object' && !Array.isArray(data);
  const isArray = Array.isArray(data);
  const hasChildren = isObject || isArray;
  
  // Handling special cases for readability
  if (data === null) {
    return (
      <div className="border-b px-4 py-2 border-gray-200" style={{ paddingLeft: `${depth * 20 + 16}px` }}>
        <span className="font-medium">{label}:</span> <span className="text-gray-500">null</span>
      </div>
    );
  }
  
  if (data === undefined) {
    return (
      <div className="border-b px-4 py-2 border-gray-200" style={{ paddingLeft: `${depth * 20 + 16}px` }}>
        <span className="font-medium">{label}:</span> <span className="text-gray-500">undefined</span>
      </div>
    );
  }
  
  // Special case for Set objects
  if (data instanceof Set) {
    return (
      <div className="border-b px-4 py-2 border-gray-200" style={{ paddingLeft: `${depth * 20 + 16}px` }}>
        <span className="font-medium">{label}:</span> <span className="text-gray-800">Set</span>{' '}
        <span className="text-gray-500">{`{${Array.from(data).join(', ')}}`}</span>
      </div>
    );
  }
  
  // Special case for Map objects (it's a class instance in real implementation)
  if (data instanceof Map || (typeof data === 'object' && data !== null && data.constructor && data.constructor.name === 'Map')) {
    return (
      <div className="border-b px-4 py-2 border-gray-200" style={{ paddingLeft: `${depth * 20 + 16}px` }}>
        <span className="font-medium">{label}:</span> <span className="text-gray-800">Map</span>{' '}
        <span className="text-gray-500">[Object]</span>
      </div>
    );
  }
  
  if (!hasChildren) {
    let valueDisplay = String(data);
    let valueClass = "text-gray-800";
    
    // Format different types
    if (typeof data === 'string') {
      valueDisplay = `"${data}"`;
      valueClass = "text-gray-800";
    } else if (typeof data === 'number') {
      valueClass = "text-gray-800";
    } else if (typeof data === 'boolean') {
      valueClass = "text-gray-800";
    }
    
    // Date detection (simple ISO string check)
    if (typeof data === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(data)) {
      try {
        const date = new Date(data);
        if (!isNaN(date.getTime())) {
          valueDisplay = `"${data}" (${date.toLocaleString()})`;
          valueClass = "text-gray-800";
        }
      } catch (e) {
        // Not a valid date, keep as string
      }
    }
    
    return (
      <div className="border-b px-4 py-2 border-gray-200" style={{ paddingLeft: `${depth * 20 + 16}px` }}>
        <span className="font-medium">{label}:</span> <span className={valueClass}>{valueDisplay}</span>
      </div>
    );
  }
  
  // For objects and arrays
  return (
    <>
      <div 
        className="border-b px-4 py-2 flex items-center cursor-pointer hover:bg-gray-50 border-gray-200"
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        onClick={() => toggleNode(path)}
      >
        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span className="font-medium ml-1">{label}</span>
        {isArray && <span className="text-gray-500 ml-2">[{data.length}]</span>}
        {!isExpanded && isObject && !isArray && (
          <span className="text-gray-500 ml-2">
            {'{'}
            {Object.keys(data).slice(0, 3).join(', ')}
            {Object.keys(data).length > 3 ? ', ...' : ''}
            {'}'}
          </span>
        )}
      </div>
      
      {isExpanded && (
        <div>
          {isObject && !isArray && Object.entries(data).map(([key, value]) => (
            <StateTreeNode
              key={`${path}.${key}`}
              label={key}
              path={`${path}.${key}`}
              data={value}
              expandedNodes={expandedNodes}
              toggleNode={toggleNode}
              depth={depth + 1}
            />
          ))}
          
          {isArray && data.map((item, idx) => (
            <StateTreeNode
              key={`${path}[${idx}]`}
              label={`[${idx}]`}
              path={`${path}[${idx}]`}
              data={item}
              expandedNodes={expandedNodes}
              toggleNode={toggleNode}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </>
  );
} 