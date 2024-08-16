const { ipcRenderer } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const semver = require('semver');
const { parse } = require('@yarnpkg/lockfile');
const { shell } = require('electron');
const notifier = require('node-notifier');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);


let iconPath;
if (app.isPackaged) {
  iconPath = path.join(app.getAppPath(), 'assets', '128x128.png');
} else {
  iconPath = path.join(__dirname, 'assets', '128x128.png');
}
let projects = [];
let currentProject = null;
let githubToken = process.env.GITHUB_TOKEN;

document.addEventListener('DOMContentLoaded', async () => {
  projects = await ipcRenderer.invoke('load-projects');
  renderMainMenu();
});
ipcRenderer.on('open-project-tab', (event, projectName, tabToOpen) => {
  openProjectTab(projectName, tabToOpen);
});
ipcRenderer.on('open-project', (event, projectName) => {
  const project = projects.find(p => p.projectName === projectName);
  if (project) {
    const projectIndex = projects.indexOf(project);
    openProjectDetails(projectIndex + 1, project.projectName, project.extractedFiles, 'outdated');
  }
});
ipcRenderer.on('open-project-from-notification', (event, projectName, type) => {
  const project = projects.find(p => p.projectName === projectName);
  if (project) {
    const projectIndex = projects.indexOf(project);
    const tabToOpen = type === 'outdated' ? 'outdated' : 'vulnerabilities';
    openProjectDetails(projectIndex + 1, project.projectName, project.extractedFiles, tabToOpen);
  }
});
function parseYarnLock(yarnLockContent) {
  try {
    return parse(yarnLockContent).object;
  } catch (error) {
    console.error(`Failed to parse yarn.lock file: ${error.message}`);
    return null;
  }
}

function formatProjectName(name) {
  return name
    .replace(/[-_]/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
const convertSshUrlToHttps = (sshUrl) => {
  if (sshUrl.startsWith('ssh://git@github.com/')) {
    return sshUrl.replace('ssh://git@github.com/', 'https://github.com/');
  } else if (sshUrl.startsWith('git@github.com:')) {
    return sshUrl.replace('git@github.com:', 'https://github.com/');
  } else if (sshUrl.startsWith('git://github.com/')) {
    return sshUrl.replace('git://github.com/', 'https://github.com/');
  }
  return sshUrl;
};
function handleExternalLink(event, url) {
  event.preventDefault();
  shell.openExternal(url);
}
function renderMainMenu() {
  const appDiv = document.getElementById('app');
  appDiv.innerHTML = `
    <div class="p-6">
      <h1 class="text-2xl font-semibold mb-4 text-center text-gray-900">Main Menu</h1>
      <button id="add-project-btn" class="w-full px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-opacity-75">
        Add Project
      </button>
      <div id="projects-list" class="mt-6">
      </div>
    </div>
  `;

  document.getElementById('add-project-btn').addEventListener('click', addProject);
  renderProjectsList();
}
  document.getElementById('open-project-btn').addEventListener('click', async () => {
    const result = await ipcRenderer.invoke('open-project');
    if (result) {
      const { projectName, projectPath } = result;
      if (projects.some(project => project.projectName === projectName)) {
        alert('Project already added');
      } else {
        const extractedFiles = await extractProjectFiles(projectPath);
        projects.push({ projectName, projectPath, extractedFiles });
        renderProjectsList();
        await ipcRenderer.invoke('save-projects', projects);
      }
    }
  });

function renderProjectsList() {
  const projectsListDiv = document.getElementById('projects-list');
  projectsListDiv.innerHTML = ''; 

  projects.forEach((project, index) => {
    const projectDiv = document.createElement('div');
    projectDiv.id = `project-${index + 1}`;
    const formattedProjectName = formatProjectName(project.projectName);
    projectDiv.innerHTML = `
      <div class="mt-4 p-4 border border-gray-200 rounded-md shadow-sm flex justify-between items-center">
        <div>
          <h2 class="text-lg font-medium text-gray-900 mb-2">${formattedProjectName}</h2>
          <button class="project-details-btn px-3 py-1 text-sm font-medium text-indigo-600 bg-indigo-100 rounded-md hover:bg-indigo-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-opacity-75" data-project="${index}">
            Open Project
          </button>
        </div>
        <button class="delete-project-btn text-gray-400 hover:text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 focus-visible:ring-opacity-75" data-project="${index}">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>
    `;
    projectsListDiv.appendChild(projectDiv);

    const projectDetailsBtn = projectDiv.querySelector('.project-details-btn');
    const deleteProjectBtn = projectDiv.querySelector('.delete-project-btn');

    projectDetailsBtn.addEventListener('click', () => {
      openProjectDetails(index + 1, project.projectName, project.projectPath);
    });

    deleteProjectBtn.addEventListener('click', async () => {
      await confirmDeleteProject(index);
    });
  });
}
async function confirmDeleteProject(index) {
  const projectName = projects[index].projectName;
  const formattedProjectName = formatProjectName(projectName);
  const confirmDelete = confirm(`Are you sure you want to remove the project "${formattedProjectName}"?`);
  if (confirmDelete) {
    projects.splice(index, 1);
    renderProjectsList();
    await ipcRenderer.invoke('save-projects', projects);
  }
}
async function checkVulnerabilities(projectPath) {
  try {
    const { stdout, stderr } = await execPromise('yarn audit --json', { cwd: projectPath });
    return parseYarnAuditOutput(stdout);
  } catch (error) {
    // yarn audit exits with a non-zero code if it finds vulnerabilities
    if (error.stdout) {
      return parseYarnAuditOutput(error.stdout);
    }
    throw error;
  }
}

function parseYarnAuditOutput(output) {
  const lines = output.split('\n');
  const vulnerabilities = [];

  lines.forEach((line) => {
    if (line.startsWith('{')) {
      try {
        const json = JSON.parse(line);
        if (json.type === 'auditAdvisory') {
          vulnerabilities.push({
            name: json.data.advisory.title,
            severity: json.data.advisory.severity,
            package: json.data.advisory.module_name,
            currentVersion: json.data.advisory.findings[0].version,
            patchedIn: json.data.advisory.patched_versions,
            dependencyOf: json.data.advisory.findings[0].paths[0].split('>')[0],
            path: json.data.advisory.findings[0].paths[0],
            moreInfo: json.data.advisory.url
          });
        }
      } catch (error) {
        console.error('Error parsing JSON line:', error);
      }
    }
  });

  return vulnerabilities;
}
async function openProjectDetails(projectId, projectName, projectPath, tabToOpen = 'outdated') {
  currentProject = projects[projectId - 1];
  const appDiv = document.getElementById('app');
  const formattedProjectName = formatProjectName(projectName);
  await reExtractProjectFiles();

  // Re-extract files when opening the project
  currentProject.extractedFiles = await extractProjectFiles(currentProject.projectPath);

  appDiv.innerHTML = `
    <div class="p-6">
      <button id="back-to-main" class="mb-4 px-3 py-1 text-sm font-medium text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 focus-visible:ring-opacity-75">
        Back to Main Menu
      </button>
      <h2 class="text-2xl font-semibold mb-4 text-gray-900">${formattedProjectName}</h2>
      <div class="mb-4">
        <div class="border-b border-gray-200">
          <nav class="-mb-px flex space-x-8" aria-label="Tabs">
            <button class="tab-btn whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm" data-tab="outdated">
              Outdated Dependencies
            </button>
            <button class="tab-btn whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm" data-tab="vulnerabilities">
              Vulnerabilities
            </button>
          </nav>
        </div>
        <div id="tab-content" class="mt-4">
          <div id="outdated" class="tab-panel">
            <div class="mb-4">
              <label for="outdated-notification-frequency" class="block text-sm font-medium text-gray-700">
                Notify me of outdated priority dependencies every:
              </label>
              <select id="outdated-notification-frequency" class="mt-1 block w-full py-2 px-3 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm">
                <option value="0">Never</option>
                <option value="5">5 seconds</option>
                <option value="10">10 seconds</option>
                <option value="30">30 seconds</option>
                <option value="60">1 minute</option>
                <option value="300">5 minutes</option>
              </select>
            </div>
            <div class="flex items-center justify-center">
              <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
              <span class="ml-2 text-gray-700">Loading dependencies...</span>
            </div>
          </div>
          <div id="vulnerabilities" class="tab-panel hidden">
            <div class="mb-4">
              <label for="vulnerabilities-notification-frequency" class="block text-sm font-medium text-gray-700">
                Notify me of vulnerabilities every:
              </label>
              <select id="vulnerabilities-notification-frequency" class="mt-1 block w-full py-2 px-3 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm">
                <option value="0">Never</option>
                <option value="5">5 seconds</option>
                <option value="10">10 seconds</option>
                <option value="30">30 seconds</option>
                <option value="60">1 minute</option>
                <option value="300">5 minutes</option>
              </select>
            </div>
            <div class="flex items-center justify-center">
              <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
              <span class="ml-2 text-gray-700">Loading vulnerabilities...</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  appDiv.addEventListener('click', (event) => {
    const anchor = event.target.closest('a');
    if (anchor && anchor.href) {
      handleExternalLink(event, anchor.href);
    }
  });
  document.getElementById('back-to-main').addEventListener('click', () => {
    renderMainMenu();
  });

  // Set up notification dropdowns
  const outdatedFrequencyDropdown = document.getElementById('outdated-notification-frequency');
  const vulnerabilitiesFrequencyDropdown = document.getElementById('vulnerabilities-notification-frequency');

  outdatedFrequencyDropdown.value = currentProject.outdatedNotificationFrequency || '0';
  vulnerabilitiesFrequencyDropdown.value = currentProject.vulnerabilitiesNotificationFrequency || '0';

  outdatedFrequencyDropdown.addEventListener('change', async (event) => {
    const frequency = parseInt(event.target.value, 10);
    currentProject.outdatedNotificationFrequency = frequency;
    await saveProjectChanges();
    await setupOutdatedNotifications();
  });

  vulnerabilitiesFrequencyDropdown.addEventListener('change', async (event) => {
    const frequency = parseInt(event.target.value, 10);
    currentProject.vulnerabilitiesNotificationFrequency = frequency;
    await saveProjectChanges();
    await setupVulnerabilityNotifications();
  });

  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabButtons.forEach(button => {
    button.addEventListener('click', async () => {
      const tabName = button.getAttribute('data-tab');
      
      // Update active tab styles
      tabButtons.forEach(btn => {
        btn.classList.remove('border-indigo-500', 'text-indigo-600');
        btn.classList.add('border-transparent', 'text-gray-500', 'hover:text-gray-700', 'hover:border-gray-300');
      });
      button.classList.remove('border-transparent', 'text-gray-500', 'hover:text-gray-700', 'hover:border-gray-300');
      button.classList.add('border-indigo-500', 'text-indigo-600');

      // Show selected tab panel
      tabPanels.forEach(panel => panel.classList.add('hidden'));
      const selectedPanel = document.getElementById(tabName);
      selectedPanel.classList.remove('hidden');

      // Render content for the selected tab
      if (tabName === 'outdated') {
        selectedPanel.innerHTML = '<div class="flex items-center justify-center"><div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div><span class="ml-2 text-gray-700">Loading dependencies...</span></div>';
        const { updates, sourceFile } = await loadOutdatedDependencies();
        renderDependencyTables(updates, sourceFile);
      } else if (tabName === 'vulnerabilities') {
        selectedPanel.innerHTML = '<div class="flex items-center justify-center"><div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div><span class="ml-2 text-gray-700">Loading vulnerabilities...</span></div>';
        const vulnerabilities = await checkVulnerabilities(currentProject.projectPath);
        renderVulnerabilityTable(vulnerabilities);
      }
    });
  });

  // Open the specified tab
  const tabToClick = Array.from(tabButtons).find(btn => btn.getAttribute('data-tab') === tabToOpen);
  if (tabToClick) {
    tabToClick.click();
  } else {
    tabButtons[0].click(); 
  }

  // Setup notifications
  await setupOutdatedNotifications();
  await setupVulnerabilityNotifications();
}
async function loadOutdatedDependencies() {
  let dependencies = {};
  let sourceFile = '';

  if (currentProject.extractedFiles['yarn.lock']) {
    const yarnLockContent = currentProject.extractedFiles['yarn.lock'];
    const parsedYarnLock = parseYarnLock(yarnLockContent);

    if (parsedYarnLock) {
      sourceFile = 'yarn.lock';
      const packageJson = JSON.parse(currentProject.extractedFiles['package.json']);
      const packageJsonDependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

      Object.keys(packageJsonDependencies).forEach((pkg) => {
        const dependencyKey = `${pkg}@${packageJsonDependencies[pkg]}`;
        if (parsedYarnLock[dependencyKey]) {
          dependencies[pkg] = parsedYarnLock[dependencyKey].version;
        } else {
          Object.keys(parsedYarnLock).forEach((key) => {
            const [lockedPkg, version] = key.split('@').filter(Boolean);
            if (pkg === lockedPkg && parsedYarnLock[key]) {
              dependencies[pkg] = parsedYarnLock[key].version;
            }
          });
        }
      });
    }
  }

  if (Object.keys(dependencies).length === 0 && currentProject.extractedFiles['package.json']) {
    sourceFile = 'package.json';
    const packageJson = JSON.parse(currentProject.extractedFiles['package.json']);
    dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  }

  if (Object.keys(dependencies).length === 0) {
    sourceFile = 'none';
  }

  const updates = await getDependencyUpdates(dependencies);
  return { updates, sourceFile };
}

async function getDependencyUpdates(dependencies) {
  const updates = await Promise.all(Object.entries(dependencies).map(async ([pkg, currentVersion]) => {
    const normalizedCurrentVersion = normalizeVersion(currentVersion);
    const pkgInfo = await getPackageInfo(pkg);
    if (pkgInfo && pkgInfo.latestVersion !== normalizedCurrentVersion) {
      return {
        pkg,
        currentVersion: normalizedCurrentVersion,
        latestVersion: pkgInfo.latestVersion,
        docUrl: pkgInfo.docUrl,
        isPriority: currentProject.priorityPackages && currentProject.priorityPackages.includes(pkg),
        versionDifference: calculateVersionDifference(normalizedCurrentVersion, pkgInfo.latestVersion),
      };
    }
  }));
  return updates.filter(update => update).sort((a, b) => b.versionDifference - a.versionDifference);
}

function normalizeVersion(version) {
  return version.replace(/^[\^~]/, '');
}

async function getPackageInfo(pkg) {
  try {
    const response = await axios.get(`https://registry.npmjs.org/${pkg}`);
    const latestVersion = response.data['dist-tags'].latest;
    const repositoryUrl = response.data.repository && response.data.repository.url;
    const docUrl = await getDocUrl(pkg, repositoryUrl ? repositoryUrl.replace('git+', '').replace('.git', '') : null);
    return { latestVersion, docUrl };
  } catch (error) {
    console.error(`Failed to fetch info for ${pkg}: ${error.message}`);
    return null;
  }
}


function renderDependencyTables(updates, sourceFile) {
  const maxNameLength = Math.max(...updates.map(update => update.pkg.length));
  const minWidth = `${maxNameLength * 8}px`;

  const outdatedTab = document.getElementById('outdated');
  outdatedTab.innerHTML = ''; // Clear existing content

  let content = `
    <div class="mb-4">
      <label for="outdated-notification-frequency" class="block text-sm font-medium text-gray-700">
        Notify me of outdated priority dependencies every:
      </label>
      <select id="outdated-notification-frequency" class="mt-1 block w-full py-2 px-3 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm">
        <option value="0">Never</option>
        <option value="5">5 seconds</option>
        <option value="10">10 seconds</option>
        <option value="30">30 seconds</option>
        <option value="60">1 minute</option>
        <option value="300">5 minutes</option>
      </select>
    </div>
  `;

  let sourceInfo = '';
  if (sourceFile === 'yarn.lock') {
    sourceInfo = '<p class="text-gray-700 mb-4">Dependency information sourced from yarn.lock file.</p>';
  } else if (sourceFile === 'package.json') {
    sourceInfo = '<p class="text-gray-700 mb-4">Dependency information sourced from package.json file (yarn.lock not found or invalid).</p>';
  } else {
    sourceInfo = '<p class="text-red-500 mb-4">No valid dependency information found. Please ensure your project has a yarn.lock or package.json file.</p>';
  }

  content += sourceInfo;

  const priorityUpdates = updates.filter(update => update.isPriority);
  const otherUpdates = updates.filter(update => !update.isPriority);

  content += `
    <div id="priority-updates">
      <h3 class="text-xl font-semibold mb-2 text-gray-900">Priority Updates</h3>
      <table class="min-w-full divide-y divide-gray-200">
        <thead class="bg-gray-50">
          <tr>
            <th style="min-width: ${minWidth}" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Package</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Current Version</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Latest Version</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Docs</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
          </tr>
        </thead>
        <tbody id="priority-tbody" class="bg-white divide-y divide-gray-200"></tbody>
      </table>
    </div>
    <div id="other-updates" class="mt-6">
      <h3 class="text-xl font-semibold mb-2 text-gray-900">Other Updates</h3>
      <table class="min-w-full divide-y divide-gray-200">
        <thead class="bg-gray-50">
          <tr>
            <th style="min-width: ${minWidth}" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Package</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Current Version</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Latest Version</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Docs</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
          </tr>
        </thead>
        <tbody id="other-tbody" class="bg-white divide-y divide-gray-200"></tbody>
      </table>
    </div>
  `;

  outdatedTab.innerHTML = content;

  outdatedTab.addEventListener('click', (event) => {
    const anchor = event.target.closest('a');
    if (anchor && anchor.href) {
      handleExternalLink(event, anchor.href);
    }
  });
  const priorityTbody = document.getElementById('priority-tbody');
  const otherTbody = document.getElementById('other-tbody');

  priorityUpdates.forEach(update => {
    priorityTbody.appendChild(createTableRow(update, true, minWidth));
  });

  otherUpdates.forEach(update => {
    otherTbody.appendChild(createTableRow(update, false, minWidth));
  });

  // Set the correct value for the notification frequency dropdown
  const frequencyDropdown = document.getElementById('outdated-notification-frequency');
  frequencyDropdown.value = currentProject.outdatedNotificationFrequency || '0';

  // Add event listener for the notification frequency dropdown
  frequencyDropdown.addEventListener('change', async (event) => {
    const frequency = parseInt(event.target.value, 10);
    currentProject.outdatedNotificationFrequency = frequency;
    await saveProjectChanges();
    await setupOutdatedNotifications();
  });

  addStarListeners();
}

function createTableRow(update, isPriority, minWidth) {
  const tr = document.createElement('tr');
  tr.setAttribute('data-pkg', update.pkg);
  tr.setAttribute('data-version-difference', update.versionDifference);
  tr.innerHTML = `
    <td style="min-width: ${minWidth}" class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${update.pkg}</td>
    <td class="px-6 py-4 whitespace-nowrap text-sm text-red-500">${update.currentVersion}</td>
    <td class="px-6 py-4 whitespace-nowrap text-sm text-green-500">${update.latestVersion}</td>
    <td class="px-6 py-4 whitespace-nowrap text-sm text-blue-500">
      <a href="${update.docUrl}" target="_blank" rel="noopener noreferrer">Docs</a>
    </td>
    <td class="px-6 py-4 whitespace-nowrap text-sm font-medium">
      <button class="priority-toggle" data-pkg="${update.pkg}" title="${isPriority ? 'Remove from Priority' : 'Add to Priority'}">
        <svg class="w-6 h-6 ${isPriority ? 'text-yellow-400' : 'text-gray-300'}" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"></path>
        </svg>
      </button>
    </td>
  `;
  return tr;
}

function addStarListeners() {
  document.querySelectorAll('.priority-toggle').forEach(button => {
    button.addEventListener('click', async (e) => {
      const pkg = e.currentTarget.getAttribute('data-pkg');
      const isPriority = e.currentTarget.querySelector('svg').classList.contains('text-yellow-400');
      if (isPriority) {
        await removeFromPriority(pkg);
      } else {
        await addToPriority(pkg);
      }
    });
  });
}

async function addToPriority(pkg) {
  if (!currentProject.priorityPackages) {
    currentProject.priorityPackages = [];
  }
  if (!currentProject.priorityPackages.includes(pkg)) {
    currentProject.priorityPackages.push(pkg);
    await saveProjectChanges();
    movePackageToPriority(pkg);
  }
}

async function removeFromPriority(pkg) {
  if (currentProject.priorityPackages) {
    const index = currentProject.priorityPackages.indexOf(pkg);
    if (index > -1) {
      currentProject.priorityPackages.splice(index, 1);
      await saveProjectChanges();
      movePackageToOther(pkg);
    }
  }
}

function movePackageToPriority(pkg) {
  const packageRow = document.querySelector(`tr[data-pkg="${pkg}"]`);
  const priorityTbody = document.getElementById('priority-tbody');
  const starIcon = packageRow.querySelector('.priority-toggle svg');
  
  starIcon.classList.replace('text-gray-300', 'text-yellow-400');
  packageRow.querySelector('.priority-toggle').setAttribute('title', 'Remove from Priority');
  
  priorityTbody.appendChild(packageRow);
}

function movePackageToOther(pkg) {
  const packageRow = document.querySelector(`tr[data-pkg="${pkg}"]`);
  const otherTbody = document.getElementById('other-tbody');
  const starIcon = packageRow.querySelector('.priority-toggle svg');
  
  starIcon.classList.replace('text-yellow-400', 'text-gray-300');
  packageRow.querySelector('.priority-toggle').setAttribute('title', 'Add to Priority');
  
  insertRowSorted(otherTbody, packageRow);
}

function insertRowSorted(tbody, row) {
  const rows = Array.from(tbody.querySelectorAll('tr'));
  const versionDifference = parseInt(row.getAttribute('data-version-difference'), 10);
  
  const insertionIndex = rows.findIndex(existingRow => {
    const existingDifference = parseInt(existingRow.getAttribute('data-version-difference'), 10);
    return existingDifference <= versionDifference;
  });

  if (insertionIndex === -1) {
    tbody.appendChild(row);
  } else {
    tbody.insertBefore(row, rows[insertionIndex]);
  }
}

async function saveProjectChanges() {
  const projectIndex = projects.findIndex(p => p.projectName === currentProject.projectName);
  if (projectIndex > -1) {
    projects[projectIndex] = currentProject;
    await ipcRenderer.invoke('save-projects', projects);
  }
}

async function getDocUrl(pkg, repoUrl) {
  if (repoUrl) {
    try {
      const httpsUrl = convertSshUrlToHttps(repoUrl);
      const hasReleases = await checkReleases(httpsUrl);
      if (hasReleases) {
        return `${httpsUrl}/releases`;
      }
    } catch (error) {
      console.error(`Error checking releases for ${repoUrl}: ${error.message}`);
    }
  }
  return `https://www.npmjs.com/package/${pkg}?activeTab=versions`;
}

async function checkReleases(repoUrl) {
  try {
    const apiUrl = repoUrl.replace('https://github.com/', 'https://api.github.com/repos/');
    const response = await axios.get(`${apiUrl}/releases`, {
      headers: githubToken ? { Authorization: `token ${githubToken}` } : {}
    });
    return response.data.length > 0;
  } catch (error) {
    console.error(`Failed to check releases for ${repoUrl}: ${error.message}`);
    return false;
  }
}

function calculateVersionDifference(currentVersion, latestVersion) {
  const current = semver.parse(currentVersion);
  const latest = semver.parse(latestVersion);
  if (!current || !latest) return 0;

  const majorDiff = latest.major - current.major;
  const minorDiff = latest.minor - current.minor;
  const patchDiff = latest.patch - current.patch;

  return majorDiff * 10000 + minorDiff * 100 + patchDiff;
}


async function extractProjectFiles(projectPath) {
  const filesToCheck = ['yarn.lock', 'package.json'];
  const extractedFiles = {};

  for (const file of filesToCheck) {
    const filePath = path.join(projectPath, file);
    try {
      extractedFiles[file] = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      console.error(`Error reading ${file}: ${error.message}`);
    }
  }

  return extractedFiles;
}
async function addProject() {
  const result = await ipcRenderer.invoke('open-project');
  if (result) {
    const { projectName, projectPath } = result;
    if (projects.some(project => project.projectName === projectName)) {
      alert('Project already added');
    } else {
      const extractedFiles = await extractProjectFiles(projectPath);
      projects.push({ projectName, projectPath, extractedFiles });
      renderProjectsList();
      await ipcRenderer.invoke('save-projects', projects);
    }
  }
}
async function reExtractProjectFiles() {
  currentProject.extractedFiles = await extractProjectFiles(currentProject.projectPath);
  await saveProjectChanges();
  await rerenderDependencyTables();
}
async function rerenderDependencyTables() {
  const outdatedTab = document.getElementById('outdated');
  if (outdatedTab) {
    const { updates, sourceFile } = await loadOutdatedDependencies();
    renderDependencyTables(updates, sourceFile);
  }

  const vulnerabilitiesTab = document.getElementById('vulnerabilities');
  if (vulnerabilitiesTab) {
    const vulnerabilities = await checkVulnerabilities(currentProject.projectPath);
    renderVulnerabilityTable(vulnerabilities);
  }
}



function renderVulnerabilityTable(vulnerabilities) {
  const vulnerabilitiesTab = document.getElementById('vulnerabilities');

  let content = `
    <div class="mb-4">
      <label for="vulnerabilities-notification-frequency" class="block text-sm font-medium text-gray-700">
        Notify me of vulnerabilities every:
      </label>
      <select id="vulnerabilities-notification-frequency" class="mt-1 block w-full py-2 px-3 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm">
        <option value="0">Never</option>
        <option value="5">5 seconds</option>
        <option value="10">10 seconds</option>
        <option value="30">30 seconds</option>
        <option value="60">1 minute</option>
        <option value="300">5 minutes</option>
      </select>
    </div>
  `;

  if (vulnerabilities.length === 0) {
    content += '<p class="text-green-500">No vulnerabilities found.</p>';
  } else {
    const severityOrder = ['critical', 'high', 'moderate', 'low'];
    vulnerabilities.sort((a, b) => 
      severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)
    );

    content += `
      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-gray-300">
          <thead class="bg-gray-50">
            <tr>
              <th scope="col" class="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-6">Vulnerability</th>
              <th scope="col" class="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Severity</th>
              <th scope="col" class="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Package</th>
              <th scope="col" class="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 bg-white">
            ${vulnerabilities.map((vuln, index) => `
              <tr>
                <td class="py-4 pl-4 pr-3 text-sm font-medium text-gray-900 sm:pl-6">${vuln.name}</td>
                <td class="px-3 py-4 text-sm ${getSeverityColor(vuln.severity)}">${vuln.severity}</td>
                <td class="px-3 py-4 text-sm text-gray-500">${vuln.package}</td>
                <td class="px-3 py-4 text-sm text-gray-500">
                  <button class="text-indigo-600 hover:text-indigo-900 vulnerability-details flex items-center" data-vuln-index="${index}">
                    <span class="mr-1">Details</span>
                    <svg class="w-4 h-4 transform transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                    </svg>
                  </button>
                </td>
              </tr>
              <tr class="vulnerability-details-row hidden bg-gray-50" data-vuln-index="${index}">
                <td colspan="4" class="px-6 py-4 text-sm text-gray-500">
                  <p><strong>Current Version:</strong> ${vuln.currentVersion}</p>
                  <p><strong>Patched in:</strong> ${vuln.patchedIn}</p>
                  <p><strong>Dependency of:</strong> ${vuln.dependencyOf}</p>
                  <p><strong>Path:</strong> ${vuln.path}</p>
                  <p><strong>More info:</strong> <a href="${vuln.moreInfo}" target="_blank" class="text-indigo-600 hover:text-indigo-900">${vuln.moreInfo}</a></p>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  vulnerabilitiesTab.innerHTML = content;
  vulnerabilitiesTab.addEventListener('click', (event) => {
    const anchor = event.target.closest('a');
    if (anchor && anchor.href) {
      handleExternalLink(event, anchor.href);
    }
  });
  // Set the correct value for the notification frequency dropdown
  const frequencyDropdown = document.getElementById('vulnerabilities-notification-frequency');
  frequencyDropdown.value = currentProject.vulnerabilitiesNotificationFrequency || '0';

  // Add event listener for the notification frequency dropdown
  frequencyDropdown.addEventListener('change', async (event) => {
    const frequency = parseInt(event.target.value, 10);
    currentProject.vulnerabilitiesNotificationFrequency = frequency;
    await saveProjectChanges();
    await setupVulnerabilityNotifications();
  });

  // Add event listeners for vulnerability details buttons
  document.querySelectorAll('.vulnerability-details').forEach(button => {
    button.addEventListener('click', (e) => {
      const index = e.target.closest('button').getAttribute('data-vuln-index');
      const detailsRow = document.querySelector(`.vulnerability-details-row[data-vuln-index="${index}"]`);
      const arrow = button.querySelector('svg');
      detailsRow.classList.toggle('hidden');
      arrow.classList.toggle('rotate-180');
    });
  });
}

function getSeverityColor(severity) {
  switch (severity) {
    case 'critical': return 'text-red-600 font-bold';
    case 'high': return 'text-orange-600 font-bold';
    case 'moderate': return 'text-yellow-600';
    case 'low': return 'text-green-600';
    default: return 'text-gray-600';
  }
}
async function setupOutdatedNotifications() {
  if (currentProject.outdatedInterval) {
    clearInterval(currentProject.outdatedInterval);
    currentProject.outdatedInterval = null;
  }

  if (currentProject.outdatedNotificationFrequency > 0) {
    currentProject.outdatedInterval = setInterval(async () => {
      await reExtractProjectFiles();
      const { updates } = await loadOutdatedDependencies();
      const outdatedPriorities = updates.filter(update => update.isPriority);
      
      if (outdatedPriorities.length > 0) {
        sendNotification(outdatedPriorities, currentProject.projectName, 'outdated');
        currentProject.lastOutdatedNotification = Date.now();
        await saveProjectChanges();
      }
    }, currentProject.outdatedNotificationFrequency * 1000);
  }
}

async function setupVulnerabilityNotifications() {
  if (currentProject.vulnerabilitiesInterval) {
    clearInterval(currentProject.vulnerabilitiesInterval);
    currentProject.vulnerabilitiesInterval = null;
  }

  if (currentProject.vulnerabilitiesNotificationFrequency > 0) {
    currentProject.vulnerabilitiesInterval = setInterval(async () => {
      await reExtractProjectFiles();
      const vulnerabilities = await checkVulnerabilities(currentProject.projectPath);
      
      if (vulnerabilities.length > 0) {
        sendNotification(vulnerabilities, currentProject.projectName, 'vulnerabilities');
        currentProject.lastVulnerabilityNotification = Date.now();
        await saveProjectChanges();
      }
    }, currentProject.vulnerabilitiesNotificationFrequency * 1000);
  }
}
function sendNotification(items, projectName, type) {
  console.log('Attempting to send notification:', { items, projectName, type });
  const formattedProjectName = formatProjectName(projectName);
  let title, message;
  
  if (type === 'outdated') {
    title = 'Outdated Priority Dependencies';
    message = `You have ${items.length} priority update(s) for the ${formattedProjectName} project.`;
  } else {
    title = 'Vulnerabilities Detected';
    message = `${formattedProjectName} has ${items.length} vulnerability(ies).`;
  }

  console.log('Notification details:', { title, message, iconPath });

  notifier.notify(
    {
      title: title,
      message: message,
      icon: iconPath,
      sound: true,
      wait: true,
      actions: ['Show'],
    },
    function(err, response, metadata) {
      if (err) {
        console.error('Notification error:', err);
      } else {
        console.log('Notification sent:', { response, metadata });
      }
      if (response === 'activate' || metadata.activationValue === 'Show') {
        console.log('Notification clicked');
        ipcRenderer.send('notification-clicked', projectName, type);
      }
    }
  );
}
function openProjectTab(projectName, tabName) {
  const project = projects.find(p => p.projectName === projectName);
  if (project) {
    const projectIndex = projects.indexOf(project);
    openProjectDetails(projectIndex + 1, project.projectName, project.projectPath, tabName);
  }
}