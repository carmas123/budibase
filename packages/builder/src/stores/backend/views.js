import { writable, derived } from "svelte/store"
import { tables } from "./"
import { API } from "api"

export function createViewsStore() {
  const store = writable({
    selectedViewName: null,
  })
  const derivedStore = derived([store, tables], ([$store, $tables]) => {
    let list = []
    $tables.list?.forEach(table => {
      list = list.concat(Object.values(table?.views || {}))
    })
    return {
      ...$store,
      list,
      selected: list.find(view => view.name === $store.selectedViewName),
    }
  })

  const select = name => {
    store.update(state => ({
      ...state,
      selectedViewName: name,
    }))
  }

  const deleteView = async view => {
    if (view.version === 2) {
      await API.viewV2.delete(view.id)
    } else {
      await API.deleteView(view.name)
    }

    // Update tables
    tables.update(state => {
      const table = state.list.find(table => table._id === view.tableId)
      delete table.views[view.name]
      return { ...state }
    })
  }

  const create = async view => {
    const savedViewResponse = await API.viewV2.create(view)
    const savedView = savedViewResponse.data

    // Update tables
    tables.update(state => {
      const table = state.list.find(table => table._id === view.tableId)
      table.views[view.name] = savedView
      return { ...state }
    })

    return savedView
  }

  const save = async view => {
    const savedView = await API.saveView(view)

    // Update tables
    tables.update(state => {
      const table = state.list.find(table => table._id === view.tableId)
      if (table) {
        if (view.originalName) {
          delete table.views[view.originalName]
        }
        table.views[view.name] = savedView
      }
      return { ...state }
    })
  }

  return {
    subscribe: derivedStore.subscribe,
    select,
    delete: deleteView,
    create,
    save,
  }
}

export const views = createViewsStore()
